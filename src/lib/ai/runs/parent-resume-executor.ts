import type { ModelMessage, UIMessage } from "ai";
import type { ResolvedPolicySnapshot } from "../runtime/contracts";
import type { RuntimeToolMode } from "../agent/runtime-context";
import type { RunPreparationSnapshot } from "../runtime/run-preparer";
import type { ClaimedParentRun, ParentRunCheckpoint } from "./types";

export type ParentResumeGeneration = {
  text: string;
  responseMessages: Array<{
    role: "assistant" | "tool";
    content: unknown;
  }>;
  usage?: { totalTokens?: number };
  signal: AbortSignal;
  assertActive(): void;
  fail(error: unknown): Promise<unknown>;
  finalize(result: Record<string, unknown>, value?: unknown): Promise<unknown>;
  checkpoint(checkpoint: ParentRunCheckpoint): Promise<unknown>;
};

export type ParentResumeExecutorDependencies = {
  claim(parentRunId: string): Promise<ClaimedParentRun | null>;
  resolve(claimed: ClaimedParentRun, messages: ModelMessage[]): Promise<{
    preparationSnapshot?: RunPreparationSnapshot;
    generate(messages: ModelMessage[]): Promise<ParentResumeGeneration>;
  }>;
  saveAssistant(input: {
    threadId: string;
    messageId: string;
    parts: UIMessage["parts"];
    modelConfig: Record<string, unknown>;
  }): Promise<void>;
  fail(claimed: ClaimedParentRun, error: unknown): Promise<void>;
};

export function resolveParentResumeAuthorization(
  recipe: Record<string, unknown>,
) {
  const resolvedPolicy = recipe.resolvedPolicy as
    | ResolvedPolicySnapshot
    | undefined;
  const toolChoice = recipe.toolChoice as RuntimeToolMode | undefined;
  if (!resolvedPolicy?.approvalPolicy || !toolChoice) {
    throw new Error("PARENT_RESUME_POLICY_REQUIRED");
  }
  return { resolvedPolicy, toolChoice };
}

export function responseMessagesToUIParts(
  messages: ParentResumeGeneration["responseMessages"],
): UIMessage["parts"] {
  const parts: any[] = [];
  const toolParts = new Map<string, any>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as any[]) {
      if (part.type === "text" && part.text) {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "reasoning" && part.text) {
        parts.push({ type: "reasoning", text: part.text });
      } else if (part.type === "tool-call") {
        const uiPart = {
          type: `tool-${part.toolName}`,
          toolCallId: part.toolCallId,
          state: "input-available",
          input: part.input,
        };
        toolParts.set(part.toolCallId, uiPart);
        parts.push(uiPart);
      } else if (part.type === "tool-result") {
        const existing = toolParts.get(part.toolCallId);
        const output =
          part.output?.type === "json" ? part.output.value : part.output;
        if (existing) {
          existing.state = "output-available";
          existing.output = output;
        } else {
          const uiPart = {
            type: `tool-${part.toolName}`,
            toolCallId: part.toolCallId,
            state: "output-available",
            output,
          };
          toolParts.set(part.toolCallId, uiPart);
          parts.push(uiPart);
        }
      }
    }
  }
  return parts as UIMessage["parts"];
}

export function replaceJoinedToolResults(
  messages: unknown[],
  joins: ClaimedParentRun["joins"],
) {
  const observations = new Map(
    joins.map((join) => [join.toolCallId, join.observation]),
  );
  return messages.map((message: any) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part: any) =>
          part.type === "tool-result" && observations.has(part.toolCallId)
            ? {
                ...part,
                output: {
                  type: "json",
                  value: observations.get(part.toolCallId),
                },
              }
            : part,
        )
      : message.content,
  })) as ModelMessage[];
}

export function successfulDelegationToolCallIds(
  messages: readonly ParentResumeGeneration["responseMessages"][number][],
) {
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as any[]) {
      if (
        part.type === "tool-call" &&
        part.toolName === "delegate_agent" &&
        typeof part.toolCallId === "string"
      )
        calls.add(part.toolCallId);
    }
  }
  const accepted = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as any[]) {
      const value = part.output?.type === "json" ? part.output.value : part.output;
      if (
        part.type === "tool-result" &&
        part.toolName === "delegate_agent" &&
        calls.has(part.toolCallId) &&
        value?.status === "accepted" &&
        typeof value.childRunId === "string"
      )
        accepted.add(part.toolCallId);
    }
  }
  return [...accepted];
}

function currentGenerationJoins(claimed: ClaimedParentRun) {
  return claimed.joins.filter(
    (join) => join.checkpointGeneration === claimed.checkpoint.generation,
  );
}

export function createParentResumeExecutor(
  dependencies: ParentResumeExecutorDependencies,
) {
  return async (parentRunId: string) => {
    const claimed = await dependencies.claim(parentRunId);
    if (!claimed) return;
    let terminalAttempted = false;
    let generated: ParentResumeGeneration | undefined;
    try {
      const messages = replaceJoinedToolResults(
        claimed.checkpoint.modelMessages,
        currentGenerationJoins(claimed),
      );
      const runtime = await dependencies.resolve(claimed, messages);
      generated = await runtime.generate(messages);
      const responseMessages = [
        ...claimed.checkpoint.responseMessages,
        ...generated.responseMessages,
      ] as ParentResumeGeneration["responseMessages"];
      const recipe = claimed.checkpoint.authorizationRecipe;
      const threadId = String(recipe.threadId ?? "");
      if (!threadId) throw new Error("PARENT_RESUME_THREAD_REQUIRED");
      generated.assertActive();
      await dependencies.saveAssistant({
        threadId,
        messageId: claimed.checkpoint.assistantMessageId,
        parts: responseMessagesToUIParts(responseMessages),
        modelConfig: claimed.checkpoint.modelConfig,
      });
      generated.assertActive();
      const delegationToolCallIds = successfulDelegationToolCallIds(
        generated.responseMessages,
      );
      if (delegationToolCallIds.length) {
        terminalAttempted = true;
        await generated.checkpoint({
          goalRequirement: claimed.checkpoint.goalRequirement,
          delegationToolCallIds,
          responseMessages,
          modelMessages: [...messages, ...generated.responseMessages],
          modelConfig: claimed.checkpoint.modelConfig,
          authorizationRecipe: {
            ...recipe,
            routingSnapshot:
              runtime.preparationSnapshot?.routing ?? recipe.routingSnapshot,
            budgetSnapshot:
              runtime.preparationSnapshot?.budget ?? recipe.budgetSnapshot,
            completionSnapshot:
              runtime.preparationSnapshot?.completion ??
              recipe.completionSnapshot,
            contextSnapshot:
              runtime.preparationSnapshot?.context ?? recipe.contextSnapshot,
            modelSnapshot:
              runtime.preparationSnapshot?.model ?? recipe.modelSnapshot,
            driverSnapshot:
              runtime.preparationSnapshot?.driver ?? recipe.driverSnapshot,
          },
          assistantMessageId: claimed.checkpoint.assistantMessageId,
        });
        return;
      }
      terminalAttempted = true;
      await generated.finalize(
        {
          assistantMessageId: claimed.checkpoint.assistantMessageId,
          totalTokens: generated.usage?.totalTokens,
        },
        responseMessages,
      );
    } catch (error) {
      if (!terminalAttempted) {
        if (generated) await generated.fail(error);
        else await dependencies.fail(claimed, error);
      }
    }
  };
}
