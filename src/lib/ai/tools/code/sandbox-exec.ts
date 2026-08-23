import { tool } from "ai";
import type { SandboxManager, SandboxProfile } from "lib/sandbox";
import { z } from "zod";

export const SANDBOX_EXEC_TOOL_NAME = "sandbox_exec";

type SandboxExecContext = {
  runId: string;
  userId: string;
  workspaceId?: string;
  taskId?: string;
};

function execContext(value: unknown): SandboxExecContext {
  if (!value || typeof value !== "object")
    throw new Error("SANDBOX_EXEC_RUNTIME_CONTEXT_REQUIRED");
  const context = value as Record<string, unknown>;
  if (typeof context.runId !== "string" || typeof context.userId !== "string")
    throw new Error("SANDBOX_EXEC_RUNTIME_CONTEXT_REQUIRED");
  return context as SandboxExecContext;
}

export function createSandboxExecTool(input: {
  manager: SandboxManager;
  profile: SandboxProfile;
  maxComputeMs: number;
}) {
  return tool({
    description:
      "Run an allowlisted command in the run-scoped isolated Linux workspace. Use for pytest, archive tools, file inspection, and bounded project workflows.",
    inputSchema: z.object({
      executable: z.enum([
        "python",
        "python3",
        "pytest",
        "zip",
        "unzip",
        "tar",
        "gzip",
        "gunzip",
        "file",
        "find",
        "grep",
        "sed",
        "awk",
        "jq",
      ]),
      args: z.array(z.string().max(4_096)).max(64),
      cwd: z
        .string()
        .regex(/^\/workspace(?:\/[A-Za-z0-9._-]+)*$/)
        .optional(),
      env: z
        .record(z.string(), z.string().max(4_096))
        .refine((value) => Object.keys(value).length <= 32)
        .optional(),
      timeoutMs: z.number().int().positive().max(300_000).optional(),
    }),
    execute: async (request, options) => {
      const context = execContext(options.context);
      return input.manager.execute({
        scope: context,
        profile: input.profile,
        request,
        maxComputeMs: input.maxComputeMs,
        signal: options.abortSignal,
      });
    },
  });
}
