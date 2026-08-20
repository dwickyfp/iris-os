import { tool } from "ai";
import type { SandboxManager, SandboxProfile } from "lib/sandbox";
import { z } from "zod";

export const PYTHON_COMPUTE_TOOL_NAME = "python_compute";

type PythonComputeContext = {
  runId: string;
  userId: string;
  workspaceId?: string;
  taskId?: string;
};

function computeContext(value: unknown): PythonComputeContext {
  if (!value || typeof value !== "object")
    throw new Error("PYTHON_COMPUTE_RUNTIME_CONTEXT_REQUIRED");
  const context = value as Record<string, unknown>;
  if (typeof context.runId !== "string" || typeof context.userId !== "string")
    throw new Error("PYTHON_COMPUTE_RUNTIME_CONTEXT_REQUIRED");
  return context as PythonComputeContext;
}

export function createPythonComputeTool(input: {
  manager: SandboxManager;
  profile: SandboxProfile;
  maxComputeMs: number;
  stageArtifacts?(input: {
    context: PythonComputeContext;
    artifacts: Array<{ artifactId: string; destination: string }>;
  }): Promise<Array<{ path: string; content: string; encoding: "base64" }>>;
}) {
  return tool({
    description:
      "Run Python in an isolated server-side compute sandbox. Sessions are managed automatically and reused within the current run.",
    inputSchema: z.object({
      code: z.string().min(1).max(200_000),
      inputArtifacts: z
        .array(
          z.object({
            artifactId: z.string().uuid(),
            destination: z.string().min(1).max(500),
          }),
        )
        .max(20)
        .optional(),
      outputPaths: z.array(z.string().min(1).max(500)).max(32).optional(),
      timeoutMs: z.number().int().positive().optional(),
    }),
    execute: async (request, options) => {
      const context = computeContext(options.context);
      const files = request.inputArtifacts?.length
        ? await input.stageArtifacts?.({
            context,
            artifacts: request.inputArtifacts,
          })
        : undefined;
      if (request.inputArtifacts?.length && !files)
        throw new Error("SANDBOX_ARTIFACT_STAGING_UNAVAILABLE");
      return input.manager.executePython({
        scope: context,
        profile: input.profile,
        request: {
          code: request.code,
          files,
          outputPaths: request.outputPaths,
          timeoutMs: request.timeoutMs,
        },
        maxComputeMs: input.maxComputeMs,
        signal: options.abortSignal,
      });
    },
  });
}
