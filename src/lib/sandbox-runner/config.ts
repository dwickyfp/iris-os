import { z } from "zod";

const digestImage =
  /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64})$/;

const schema = z.object({
  SANDBOX_RUNNER_TOKEN: z.string().min(32),
  SANDBOX_RUNNER_IMAGE: z.string().regex(digestImage),
  SANDBOX_RUNNER_SOCKET: z
    .string()
    .startsWith("/")
    .default("/var/run/docker.sock"),
  SANDBOX_RUNNER_HOST: z.string().default("127.0.0.1"),
  SANDBOX_RUNNER_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  SANDBOX_RUNNER_SESSION_TTL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(900_000),
  SANDBOX_RUNNER_IDLE_TTL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(300_000),
  SANDBOX_RUNNER_REAPER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .default(30_000),
  SANDBOX_RUNNER_EXEC_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(30_000),
  SANDBOX_RUNNER_MEMORY_BYTES: z.coerce
    .number()
    .int()
    .min(16 * 1024 * 1024)
    .default(256 * 1024 * 1024),
  SANDBOX_RUNNER_NANO_CPUS: z.coerce.number().int().min(1).default(500_000_000),
  SANDBOX_RUNNER_PIDS_LIMIT: z.coerce.number().int().min(1).default(64),
  SANDBOX_RUNNER_TMPFS_BYTES: z.coerce
    .number()
    .int()
    .min(1024 * 1024)
    .default(64 * 1024 * 1024),
  SANDBOX_RUNNER_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(16 * 1024 * 1024),
  SANDBOX_RUNNER_MAX_FILE_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(8 * 1024 * 1024),
  SANDBOX_RUNNER_MAX_ARCHIVE_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(16 * 1024 * 1024),
  SANDBOX_RUNNER_MAX_ARCHIVE_FILES: z.coerce.number().int().min(1).default(256),
  SANDBOX_RUNNER_MAX_EXEC_OUTPUT_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .default(4 * 1024 * 1024),
  SANDBOX_RUNNER_MAX_CONCURRENT_SESSIONS: z.coerce
    .number()
    .int()
    .min(1)
    .default(4),
  SANDBOX_RUNNER_CHILD_BROKER_NETWORK: z.string().trim().min(1).optional(),
  SANDBOX_SECURITY_RUN_ID: z
    .string()
    .regex(/^iris-security-[A-Za-z0-9_.-]+$/)
    .optional(),
});

export type SandboxRunnerConfig = z.infer<typeof schema>;

export function parseSandboxRunnerConfig(
  env: NodeJS.ProcessEnv,
): SandboxRunnerConfig {
  return schema.parse(env);
}
