import {
  type LanguageModel,
  type Tool,
  type UIMessage,
  ToolLoopAgent,
  isStepCount,
  readUIMessageStream,
  toUIMessageStream,
  tool,
} from "ai";
import type { AgentRuntimeContext } from "../../agent/runtime-context";
import {
  SUBAGENT_SPECS,
  type SpawnSubagentOutput,
  extractSubagentProgressText,
  isSpawnSubagentOutput,
  selectSubagentTools,
  subagentInputSchema,
} from "./definitions";

/** Hard cap for a single subagent run inside the parent's tool loop. */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 120_000;

export function subagentToolTimeoutMs(
  env: Record<string, string | undefined> = process.env,
) {
  const parsed = Number.parseInt(env.AI_SUBAGENT_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SUBAGENT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 30_000), 300_000);
}

function slugifyFilename(title: string) {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "subagent-report";
  return `${slug}.md`;
}

export type SpawnSubagentToolDependencies = {
  model: LanguageModel;
  runtimeContext: AgentRuntimeContext;
  artifacts: {
    create: (input: {
      content: string;
      filename: string;
      mediaType: string;
      userId: string;
      runId: string;
    }) => Promise<{
      artifactId: string;
      filename: string;
      mediaType: string;
      size: number;
    }>;
  };
  parentTools: Record<string, Tool>;
  timeoutMs?: number;
  maxSteps?: number;
};

/**
 * Creates the `spawn_subagent` tool following the AI SDK subagents pattern:
 * the parent delegates a self-contained task to a child `ToolLoopAgent` with
 * its own context window. Subagent progress is streamed to the UI as
 * preliminary tool results (accumulated UIMessages) while the model only ever
 * sees the final report through `toModelOutput`. The final report is stored as
 * a canonical Markdown artifact for the right-side artifact panel.
 */
export function createSpawnSubagentTool({
  model,
  runtimeContext,
  artifacts,
  parentTools,
  timeoutMs = subagentToolTimeoutMs(),
  maxSteps = 12,
}: SpawnSubagentToolDependencies) {
  return tool({
    description:
      "Spawn a specialized subagent (research, audit, or general) that works autonomously on a self-contained task and returns a Markdown report artifact. Use it for work that needs heavy exploration or isolated focus, e.g. in-depth research or a critical audit.",
    inputSchema: subagentInputSchema,
    execute: async function* execute({ subagent, title, task }, options) {
      const abortSignal = options.abortSignal;
      const startedAt = Date.now();
      const spec = SUBAGENT_SPECS[subagent];
      const child = new ToolLoopAgent({
        model,
        instructions: spec.instructions,
        tools: selectSubagentTools(parentTools),
        stopWhen: [isStepCount(maxSteps)],
        timeout: { totalMs: timeoutMs, stepMs: timeoutMs },
      });
      const result = await child.stream({ prompt: task, abortSignal });

      // Every yielded value except the last is a preliminary result: an
      // ever-growing UIMessage of the subagent's work so far.
      let finalMessage: UIMessage | undefined;
      for await (const message of readUIMessageStream({
        stream: toUIMessageStream({ stream: result.stream }),
      })) {
        finalMessage = message;
        yield message;
      }

      const report = finalMessage
        ? extractSubagentProgressText(finalMessage)
        : "";
      const steps = finalMessage
        ? finalMessage.parts.filter((part) => part.type === "step-start").length
        : 0;
      const durationMs = Date.now() - startedAt;

      let artifact: SpawnSubagentOutput["artifact"] = null;
      try {
        const reference = await artifacts.create({
          content: report,
          filename: slugifyFilename(title),
          mediaType: "text/markdown",
          userId: runtimeContext.userId,
          runId: runtimeContext.runId,
        });
        artifact = {
          artifactId: reference.artifactId,
          filename: reference.filename,
          mediaType: reference.mediaType,
          size: reference.size,
        };
      } catch (error) {
        console.error("spawn_subagent artifact storage failed", error);
      }

      const output: SpawnSubagentOutput = {
        status: "completed",
        subagent,
        task,
        title,
        report,
        artifact,
        steps,
        durationMs,
      };
      return output;
    },
    toModelOutput: ({
      output,
    }: {
      toolCallId: string;
      input: unknown;
      output: unknown;
    }) => {
      if (isSpawnSubagentOutput(output)) {
        return {
          type: "text",
          value: `Subagent report ("${output.title}"):\n\n${output.report}${
            output.artifact
              ? `\n\n(Stored as artifact ${output.artifact.artifactId})`
              : ""
          }`,
        };
      }
      // Preliminary UIMessage output (only observed if the run is inspected
      // mid-flight): give the model the subagent's latest text.
      const progress =
        output && typeof output === "object" && "parts" in output
          ? extractSubagentProgressText(output as never)
          : "";
      return { type: "text", value: progress || "Subagent task completed." };
    },
  }) as Tool;
}
