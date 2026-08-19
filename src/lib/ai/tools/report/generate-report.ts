import { tool as createTool } from "ai";
import { z } from "zod";
import type { ArtifactService } from "../../artifacts";
import type { Verifier } from "../../runtime/verification";

type ReportRuntimeContext = { userId: string; runId: string };

function reportRuntimeContext(value: unknown): ReportRuntimeContext {
  if (!value || typeof value !== "object") {
    throw new Error("REPORT_RUNTIME_CONTEXT_REQUIRED");
  }
  const { userId, runId } = value as Record<string, unknown>;
  if (
    typeof userId !== "string" ||
    !userId ||
    typeof runId !== "string" ||
    !runId
  ) {
    throw new Error("REPORT_RUNTIME_CONTEXT_REQUIRED");
  }
  return { userId, runId };
}

export function createGenerateReportTool(dependencies: {
  artifacts: ArtifactService;
  verify: Verifier["verify"];
}) {
  return createTool({
    description:
      "Generate, store, and verify a canonical Markdown report artifact.",
    inputSchema: z.object({
      title: z.string().trim().min(1).max(240),
      markdown: z.string().min(1),
      filename: z
        .string()
        .trim()
        .min(1)
        .max(240)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/),
    }),
    execute: async ({ title, markdown, filename }, options) => {
      const { userId, runId } = reportRuntimeContext(options.context);
      const content = `# ${title}\n\n${markdown.trim()}\n`;
      const artifact = await dependencies.artifacts.create({
        content,
        filename,
        mediaType: "text/markdown",
        userId,
        runId,
      });
      const verification = await dependencies.verify({
        kind: "artifact",
        value: artifact,
        mediaType: artifact.mediaType,
        expectedUserId: userId,
        expectedRunId: runId,
      });
      if (!verification.verified) {
        throw new Error(`REPORT_VERIFICATION_FAILED:${verification.reason}`);
      }
      return { artifact, verification };
    },
  });
}
