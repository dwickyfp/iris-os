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
  /**
   * Optional. When omitted, the runtime context (userId/runId used for
   * artifact ownership) is read from the tool execute options context that
   * the ToolLoopAgent provides at call time. This allows registering the tool
   * before run preparation so it is included in the policy authority.
   */
  runtimeContext?: AgentRuntimeContext;
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
  /** Heartbeat interval that keeps the parent's chunk timeout fed. */
  keepaliveMs?: number;
  /** Minimum gap between preliminary progress yields. */
  throttleMs?: number;
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
  keepaliveMs = 10_000,
  throttleMs = 750,
}: SpawnSubagentToolDependencies) {
  return tool({
    description:
      "Spawn a specialized subagent (research, audit, or general) that works autonomously on a self-contained task and returns a Markdown report artifact. Use it for work that needs heavy exploration or isolated focus, e.g. in-depth research or a critical audit.",
    inputSchema: subagentInputSchema,
    execute: async function* execute({ subagent, title, task }, options) {
      const abortSignal = options.abortSignal;
      const ctx: AgentRuntimeContext | undefined =
        runtimeContext ?? (options.context as AgentRuntimeContext | undefined);
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

      // Stream the subagent's accumulated UIMessage as preliminary results.
      // While the subagent is silent (model latency, its own tool calls) the
      // parent's chunk timeout (15s) would kill the whole run, so re-yield
      // the last progress as a keepalive heartbeat on a shorter interval.
      const iterator = readUIMessageStream({
        stream: toUIMessageStream({ stream: result.stream }),
      })[Symbol.asyncIterator]();
      let lastMessage: UIMessage | undefined;
      let pending: Promise<IteratorResult<UIMessage>> | undefined;
      let lastYieldedAt = 0;
      while (true) {
        if (!pending) pending = iterator.next();
        const step = await new Promise<
          | { chunk: IteratorResult<UIMessage> }
          | { timeout: true }
          | { error: unknown }
        >((resolve) => {
          const timer = setTimeout(
            () => resolve({ timeout: true }),
            keepaliveMs,
          );
          pending!.then(
            (chunk) => {
              clearTimeout(timer);
              resolve({ chunk });
            },
            (error) => {
              clearTimeout(timer);
              resolve({ error });
            },
          );
        });
        if ("error" in step) throw step.error;
        const now = Date.now();
        if ("timeout" in step) {
          // Heartbeat: re-emit the last progress (or an empty message before
          // the subagent's first chunk) so the parent's chunk timeout never
          // fires while the subagent is still working.
          lastYieldedAt = now;
          yield lastMessage ?? {
            id: `subagent-heartbeat-${options.toolCallId ?? startedAt}`,
            role: "assistant",
            parts: [],
          };
          continue;
        }
        pending = undefined;
        if (step.chunk.done) break;
        lastMessage = step.chunk.value;
        // Throttle preliminary updates: with two parallel subagents the raw
        // chunk rate would flood the parent stream and cost CPU in the UI.
        if (now - lastYieldedAt >= throttleMs) {
          lastYieldedAt = now;
          yield lastMessage;
        }
      }
      const finalMessage = lastMessage;

      const report = finalMessage
        ? extractSubagentProgressText(finalMessage)
        : "";
      const steps = finalMessage
        ? finalMessage.parts.filter((part) => part.type === "step-start").length
        : 0;
      const durationMs = Date.now() - startedAt;

      let artifact: SpawnSubagentOutput["artifact"] = null;
      if (ctx?.userId && ctx?.runId) {
        try {
          const reference = await artifacts.create({
            content: report,
            filename: slugifyFilename(title),
            mediaType: "text/markdown",
            userId: ctx.userId,
            runId: ctx.runId,
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
      } else {
        console.error(
          "spawn_subagent skipped artifact storage: no runtime context",
        );
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
      // AI SDK semantics for generator executes: the LAST yield is the final
      // tool output; a generator return value is discarded by executeTool.
      yield output;
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
