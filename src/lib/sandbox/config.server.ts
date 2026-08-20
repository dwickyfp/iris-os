import "server-only";

import { z } from "zod";
import type { SandboxProfile } from "./contracts";

const BooleanString = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((value) => value === "1" || value === "true");

const EnvironmentSchema = z
  .object({
    IRIS_SANDBOX_ENABLED: BooleanString,
    IRIS_SANDBOX_PROVIDER: z.string().trim().min(1).default("iris-runner"),
    IRIS_RUNNER_URL: z.string().url().optional(),
    IRIS_RUNNER_TOKEN: z.string().min(32).optional(),
  })
  .superRefine((value, context) => {
    if (value.IRIS_SANDBOX_ENABLED && !value.IRIS_RUNNER_URL)
      context.addIssue({
        code: "custom",
        path: ["IRIS_RUNNER_URL"],
        message: "is required when sandbox is enabled",
      });
    if (value.IRIS_SANDBOX_ENABLED && !value.IRIS_RUNNER_TOKEN)
      context.addIssue({
        code: "custom",
        path: ["IRIS_RUNNER_TOKEN"],
        message: "is required when sandbox is enabled",
      });
  });

export const DEFAULT_SANDBOX_PROFILE: SandboxProfile = {
  id: "python-standard-v1",
  cpuMillis: 1_000,
  memoryMb: 512,
  diskMb: 1_024,
  executionTimeoutMs: 60_000,
  idleTimeoutMs: 300_000,
  absoluteTimeoutMs: 900_000,
  network: "none",
};

export function sandboxServerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvironmentSchema.parse(environment);
  return {
    enabled: parsed.IRIS_SANDBOX_ENABLED ?? false,
    provider: parsed.IRIS_SANDBOX_PROVIDER,
    runnerUrl: parsed.IRIS_RUNNER_URL,
    runnerToken: parsed.IRIS_RUNNER_TOKEN,
    profile: DEFAULT_SANDBOX_PROFILE,
  };
}
