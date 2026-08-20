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
import type { BudgetGuard } from "../runtime/budget";

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
  budget?: BudgetGuard;
};

export function runtimeEventCallbacks(
  onRuntimeEvent?: ToolLoopAgentConfig["onRuntimeEvent"],
) {
  return {
    onLanguageModelCallStart: async (event: {
      callId: string;
      provider: string;
      modelId: string;
    }) =>
      onRuntimeEvent?.("model.requested", {
        callId: event.callId,
        provider: event.provider,
        model: event.modelId,
      }),
    onLanguageModelCallEnd: async (event: {
      callId: string;
      finishReason: string;
      usage: { totalTokens?: number };
    }) =>
      onRuntimeEvent?.("model.completed", {
        callId: event.callId,
        finishReason: event.finishReason,
        totalTokens: event.usage.totalTokens,
      }),
    onToolExecutionStart: async (event: {
      callId: string;
      toolCall: { toolCallId: string; toolName: string };
    }) =>
      onRuntimeEvent?.("tool.requested", {
        callId: event.callId,
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
      }),
    onToolExecutionEnd: async (event: {
      callId: string;
      toolCall: { toolCallId: string; toolName: string };
    }) =>
      onRuntimeEvent?.("tool.completed", {
        callId: event.callId,
        toolCallId: event.toolCall.toolCallId,
        toolName: event.toolCall.toolName,
      }),
  };
}

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
  budget,
}: ToolLoopAgentConfig) {
  const reasoningMode = getToolLoopAgentReasoningMode(profile);
  const eventCallbacks = runtimeEventCallbacks(onRuntimeEvent);
  let accountedTokens = 0;
  const guardedTools = Object.fromEntries(
    Object.entries(tools).map(([name, candidate]) => {
      if (!budget || typeof (candidate as any).execute !== "function")
        return [name, candidate];
      const original = candidate as any;
      return [
        name,
        {
          ...original,
          execute: async (args: unknown, options: unknown) => {
            budget.beforeTool();
            try {
              return await original.execute(args, options);
            } finally {
              budget.afterTool();
            }
          },
        },
      ];
    }),
  );

  return new ToolLoopAgent({
    model,
    instructions,
    tools: guardedTools,
    stopWhen: [
      isStepCount(Math.min(10, budget?.budget.maxSteps ?? 10)),
      hasToolCall("delegate_agent"),
    ],
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
    ...eventCallbacks,
    toolApproval: ({ toolCall }) => {
      budget?.assertDuration();
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
    }) => {
      const totalTokens = usage.totalTokens ?? 0;
      budget?.afterStep({ tokens: Math.max(0, totalTokens - accountedTokens) });
      accountedTokens = Math.max(accountedTokens, totalTokens);
      logger.info("agent step completed", {
        agentType: runtimeContext.agentType,
        ...(runtimeContext.agentId ? { agentId: runtimeContext.agentId } : {}),
        requestId: runtimeContext.requestId,
        stepNumber,
        finishReason,
        totalTokens: usage.totalTokens,
      });
    },
    onStepStart: async () => {
      budget?.beforeStep();
      budget?.assertDuration();
    },
  } as any);
}
