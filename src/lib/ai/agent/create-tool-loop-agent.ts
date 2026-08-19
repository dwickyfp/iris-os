import { type Tool, ToolLoopAgent, hasToolCall, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import type { Agent } from "app-types/agent";
import logger from "logger";
import type { ResolvedPolicySnapshot } from "../runtime/contracts";
import {
  type PolicyEvaluationDecision,
  destinationFromArgs,
  policyEngine,
} from "../runtime/policy-engine";
import { isReadOnlyTool } from "./approval-policy";
import type { AgentRuntimeContext } from "./runtime-context";

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
  onRuntimeEvent?: (
    eventType:
      | "model.requested"
      | "model.completed"
      | "tool.requested"
      | "tool.completed",
    payload: Record<string, unknown>,
  ) => Promise<void> | void;
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

export function evaluateToolCallPolicy(input: {
  toolName: string;
  args: unknown;
  runtimeContext: AgentRuntimeContext;
  resolvedPolicy?: ResolvedPolicySnapshot;
}): PolicyEvaluationDecision {
  const { toolName, args, runtimeContext, resolvedPolicy } = input;
  const legacy = policyEngine.evaluateTool(toolName);
  return policyEngine.evaluate({
    actor: {
      type: runtimeContext.agentType === "custom" ? "agent" : "system",
      id: runtimeContext.agentId,
      userId: runtimeContext.userId,
    },
    capability: resolvedPolicy?.capabilities?.[toolName] ?? {
      id: `tool:${toolName}`,
      key: toolName,
      risks: legacy.readOnly ? ["read"] : undefined,
    },
    action: legacy.readOnly ? "read" : "execute",
    resource: `tool:${toolName}`,
    args,
    destination: destinationFromArgs(args),
    runtime: {
      kind: runtimeContext.parentRunId ? "local_delegation" : "foreground",
      approvalPolicy:
        resolvedPolicy?.approvalPolicy ?? runtimeContext.approvalPolicy,
      runId: runtimeContext.runId,
      parentRunId: runtimeContext.parentRunId,
      authority: resolvedPolicy?.authority,
    },
  });
}

export function createToolLoopAgent({
  profile,
  model,
  instructions,
  tools,
  runtimeContext,
  resolvedPolicy,
  onRuntimeEvent,
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
    toolApproval: ({ toolCall }) => {
      const decision = evaluateToolCallPolicy({
        toolName: toolCall.toolName,
        args: (toolCall as { input?: unknown }).input,
        runtimeContext,
        resolvedPolicy,
      });
      logger.info("policy decision", decision);
      if (decision.result === "deny") throw new Error("POLICY_DENIED");
      return decision.result === "allow" ? "not-applicable" : "user-approval";
    },
    onStepEnd: async ({
      stepNumber,
      finishReason,
      usage,
      toolCalls,
      toolResults,
    }) => {
      await onRuntimeEvent?.("model.requested", { stepNumber });
      await onRuntimeEvent?.("model.completed", {
        stepNumber,
        finishReason,
        totalTokens: usage.totalTokens,
      });
      for (const toolCall of toolCalls ?? []) {
        await onRuntimeEvent?.("tool.requested", {
          stepNumber,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
        });
      }
      for (const toolResult of toolResults ?? []) {
        await onRuntimeEvent?.("tool.completed", {
          stepNumber,
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
        });
      }
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
