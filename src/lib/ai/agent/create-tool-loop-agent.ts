import { hasToolCall, isStepCount, ToolLoopAgent, type Tool } from "ai";
import type { Agent } from "app-types/agent";
import type { LanguageModel } from "ai";
import { isReadOnlyTool, requiresToolApproval } from "./approval-policy";
import type { AgentRuntimeContext } from "./runtime-context";
import logger from "logger";
import type { ResolvedPolicySnapshot } from "../runtime/contracts";

export const AGENT_TIMEOUTS = {
  totalMs: 90_000,
  stepMs: 30_000,
  chunkMs: 15_000,
  toolMs: 30_000,
} as const;

export type ToolLoopAgentProfile =
  | { type: "base" }
  | { type: "custom"; agent: Agent };

export type ToolLoopAgentConfig = {
  profile: ToolLoopAgentProfile;
  model: LanguageModel;
  instructions: string;
  tools: Record<string, Tool>;
  runtimeContext: AgentRuntimeContext;
  resolvedPolicy?: ResolvedPolicySnapshot;
};

export function getToolLoopAgentReasoningMode(profile: ToolLoopAgentProfile) {
  return profile.type === "custom"
    ? (profile.agent.instructions.reasoningMode ?? "auto")
    : "auto";
}

export function getAgentToolTimeouts(tools: Record<string, Tool>) {
  return Object.fromEntries(
    Object.entries(tools).map(([toolName, tool]) => {
      const timeout = isReadOnlyTool(toolName)
        ? 15_000
        : toolName === "mini-javascript-execution" ||
            toolName === "python-execution"
          ? 45_000
          : toolName === "image-manager" || "_workflowId" in tool
            ? 120_000
            : 30_000;
      return [`${toolName}Ms`, timeout];
    }),
  );
}

export function createToolLoopAgent({
  profile,
  model,
  instructions,
  tools,
  runtimeContext,
  resolvedPolicy,
}: ToolLoopAgentConfig) {
  const reasoningMode = getToolLoopAgentReasoningMode(profile);

  return new ToolLoopAgent({
    model,
    instructions,
    tools,
    stopWhen: [isStepCount(10), hasToolCall("delegate_agent")],
    timeout: { ...AGENT_TIMEOUTS, tools: getAgentToolTimeouts(tools) },
    runtimeContext,
    telemetry: {
      functionId:
        profile.type === "custom" ? "custom-agent" : "base-chat-agent",
      metadata: {
        agentType: runtimeContext.agentType,
        ...(runtimeContext.agentId ? { agentId: runtimeContext.agentId } : {}),
        threadId: runtimeContext.threadId,
        requestId: runtimeContext.requestId,
      },
    },
    reasoning: reasoningMode === "auto" ? undefined : { effort: reasoningMode },
    toolApproval: ({ toolCall }) =>
      (resolvedPolicy?.approvalPolicy ?? runtimeContext.approvalPolicy) ===
      "never"
        ? "not-applicable"
        : (resolvedPolicy?.approvalPolicy ?? runtimeContext.approvalPolicy) ===
              "always" ||
            (resolvedPolicy?.tools[toolCall.toolName]?.requiresApproval ??
              requiresToolApproval(toolCall.toolName))
          ? "user-approval"
          : "not-applicable",
    onStepEnd: ({ stepNumber, finishReason, usage }) => {
      logger.info("agent step completed", {
        agentType: runtimeContext.agentType,
        ...(runtimeContext.agentId ? { agentId: runtimeContext.agentId } : {}),
        requestId: runtimeContext.requestId,
        stepNumber,
        finishReason,
        totalTokens: usage.totalTokens,
      });
    },
  } as any);
}
