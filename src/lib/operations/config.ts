import { z } from "zod";

const booleanString = z
  .enum(["0", "1", "false", "true"])
  .default("false")
  .transform((value) => value === "1" || value === "true");

const operationsEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    POSTGRES_URL: z.string().url().startsWith("postgres"),
    OPERATIONS_METRICS_TOKEN: z.string().min(32).optional(),
    OPERATIONS_READY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(10_000)
      .default(3_000),
    OPERATIONS_QUERY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(5_000)
      .default(2_000),
    IRIS_WORKER_REQUIRED: booleanString,
    IRIS_WORKER_STALE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(5_000)
      .max(300_000)
      .default(45_000),
    IRIS_WORKER_HEARTBEAT_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(10_000),
    IRIS_WORKER_MAX_CONSECUTIVE_HEARTBEAT_FAILURES: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(3),
    IRIS_WORKER_ID: z.string().min(1).max(160).optional(),
    IRIS_LEARNING_V2: booleanString,
    IRIS_AUTOMATION_V2: booleanString,
    IRIS_DELEGATION_V2: booleanString,
    IRIS_REMOTE_AGENTS_A2A: booleanString,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && !value.OPERATIONS_METRICS_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["OPERATIONS_METRICS_TOKEN"],
        message: "is required in production",
      });
    }
    if (
      value.IRIS_WORKER_HEARTBEAT_INTERVAL_MS * 2 >=
      value.IRIS_WORKER_STALE_AFTER_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["IRIS_WORKER_HEARTBEAT_INTERVAL_MS"],
        message: "must be less than half of IRIS_WORKER_STALE_AFTER_MS",
      });
    }
  })
  .transform((value) => ({
    ...value,
    IRIS_WORKER_REQUIRED:
      value.IRIS_WORKER_REQUIRED ||
      value.IRIS_LEARNING_V2 ||
      value.IRIS_AUTOMATION_V2 ||
      value.IRIS_DELEGATION_V2 ||
      value.IRIS_REMOTE_AGENTS_A2A,
  }));

export type OperationsConfig = z.infer<typeof operationsEnvSchema>;

export function parseOperationsConfig(
  env: Record<string, string | undefined>,
): OperationsConfig {
  return operationsEnvSchema.parse(env);
}

export function validateOperationsConfig(
  env: Record<string, string | undefined>,
) {
  return operationsEnvSchema.safeParse(env);
}
