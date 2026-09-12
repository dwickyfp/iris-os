import { type Tool, ToolLoopAgent, hasToolCall, isStepCount } from "ai";
import type { LanguageModel } from "ai";
import type { Agent } from "app-types/agent";
import { STATIC_APP_CONFIG } from "lib/app-config";
import logger from "logger";
import type { BudgetGuard } from "../runtime/budget";
import {
  type DurableCapabilityBudget,
  createCapabilityInvoker,
  evaluateCapabilityPolicy,
} from "../runtime/capability-invoker";
import type { ResolvedPolicySnapshot } from "../runtime/contracts";
import type { PolicyEvaluationDecision } from "../runtime/policy-engine";
import { StrategyGuard } from "../runtime/strategy-guard";
import { SpawnSubagentToolName } from "../tools";
import { subagentToolTimeoutMs } from "../tools/subagent/spawn-subagent";
import { isReadOnlyTool } from "./approval-policy";
import type { AgentRuntimeContext } from "./runtime-context";

export type DurableBudgetAuthority = DurableCapabilityBudget;

const DEFAULT_AGENT_TIMEOUTS = {
  totalMs: 90_000,
  stepMs: 30_000,
  chunkMs: 15_000,
  toolMs: 30_000,
} as const;

export function configuredAgentTimeouts(environment?: NodeJS.ProcessEnv) {
  const configured =
    environment?.AI_STEP_TIMEOUT_MS ??
    String(STATIC_APP_CONFIG.ai.stepTimeoutMs);
  const stepMs = Number.parseInt(String(configured ?? ""), 10);
  if (!Number.isFinite(stepMs)) return DEFAULT_AGENT_TIMEOUTS;
  if (stepMs < 30_000 || stepMs > 300_000) {
    throw new RangeError("AI_STEP_TIMEOUT_MS must be between 30000 and 300000");
  }
  return {
    ...DEFAULT_AGENT_TIMEOUTS,
    stepMs,
    totalMs: Math.max(DEFAULT_AGENT_TIMEOUTS.totalMs, stepMs * 2),
  };
}

export const AGENT_TIMEOUTS = configuredAgentTimeouts();

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
      | "model.failed"
      | "tool.requested"
      | "tool.approval_requested"
      | "tool.approved"
      | "tool.rejected"
      | "tool.started"
      | "tool.completed"
      | "tool.failed"
      | "tool.cancelled"
      | "strategy.stalled",
    payload: Record<string, unknown>,
  ) => Promise<void> | void;
  budget?: BudgetGuard;
  durableBudget?: DurableBudgetAuthority;
  strategyGuard?: StrategyGuard;
  projectCapabilityResult?: Parameters<
    typeof createCapabilityInvoker
  >[0]["projectResult"];
};

export function runtimeEventCallbacks(
  onRuntimeEvent?: ToolLoopAgentConfig["onRuntimeEvent"],
) {
  const modelCalls = new Map<string, number>();
  return {
    onLanguageModelCallStart: async (event: {
      callId: string;
      provider: string;
      modelId: string;
    }) => {
      const startedAt = Date.now();
      modelCalls.set(event.callId, startedAt);
      return onRuntimeEvent?.("model.requested", {
        callId: event.callId,
        provider: event.provider,
        model: event.modelId,
        startedAt: new Date(startedAt).toISOString(),
      });
    },
    onLanguageModelCallEnd: async (event: {
      callId: string;
      finishReason: string;
      usage: { totalTokens?: number };
      performance?: { responseTimeMs?: number };
    }) => {
      const completedAt = Date.now();
      const startedAt = modelCalls.get(event.callId);
      modelCalls.delete(event.callId);
      return onRuntimeEvent?.("model.completed", {
        callId: event.callId,
        finishReason: event.finishReason,
        totalTokens: event.usage.totalTokens,
        ...(startedAt
          ? {
              startedAt: new Date(startedAt).toISOString(),
              durationMs: Math.max(0, completedAt - startedAt),
            }
          : {}),
        completedAt: new Date(completedAt).toISOString(),
      });
    },
    failActiveModelCall: async (error: unknown) => {
      const active = [...modelCalls.entries()].at(-1);
      if (!active) return;
      const [callId, startedAt] = active;
      modelCalls.delete(callId);
      const completedAt = Date.now();
      await onRuntimeEvent?.("model.failed", {
        callId,
        startedAt: new Date(startedAt).toISOString(),
        completedAt: new Date(completedAt).toISOString(),
        durationMs: Math.max(0, completedAt - startedAt),
        message: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

function instrumentModel<Model extends LanguageModel>(
  model: Model,
  fail: (error: unknown) => Promise<void>,
): Model {
  if ((typeof model !== "object" && typeof model !== "function") || !model)
    return model;
  return new Proxy(model as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        (property !== "doGenerate" && property !== "doStream") ||
        typeof value !== "function"
      )
        return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(target, args);
        } catch (error) {
          await fail(error);
          throw error;
        }
      };
    },
  }) as Model;
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
        : toolName === SpawnSubagentToolName
          ? subagentToolTimeoutMs()
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
  return evaluateCapabilityPolicy({
    capabilityId: input.toolName,
    args: input.args,
    runtimeContext: input.runtimeContext,
    resolvedPolicy: input.resolvedPolicy,
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
  durableBudget,
  strategyGuard = new StrategyGuard(),
  projectCapabilityResult,
}: ToolLoopAgentConfig) {
  const reasoningMode = getToolLoopAgentReasoningMode(profile);
  const agentTimeouts = configuredAgentTimeouts();
  // A subagent runs entirely inside one parent tool call, so the parent's
  // step/total timeouts must outlive the subagent's own budget.
  const hasSubagentTool = SpawnSubagentToolName in tools;
  const stepMs = hasSubagentTool
    ? Math.max(agentTimeouts.stepMs, subagentToolTimeoutMs() + 30_000)
    : agentTimeouts.stepMs;
  const timeoutConfig = {
    ...agentTimeouts,
    stepMs,
    totalMs: Math.max(agentTimeouts.totalMs, stepMs + 30_000),
    tools: getAgentToolTimeouts(tools),
  };
  const eventCallbacks = runtimeEventCallbacks(onRuntimeEvent);
  const terminalToolCalls = new Set<string>();
  const policyDecisions = new Map<string, PolicyEvaluationDecision>();
  const approvalToolCalls = new Map<
    string,
    { toolName: string; requestedAt: number }
  >();
  const emitToolTerminal = async (
    eventType: "tool.completed" | "tool.failed" | "tool.cancelled",
    toolCallId: string,
    payload: Record<string, unknown>,
  ) => {
    if (terminalToolCalls.has(toolCallId)) return;
    terminalToolCalls.add(toolCallId);
    await onRuntimeEvent?.(eventType, payload);
  };
  const recordApprovalResponses = async (messages: any[] | undefined) => {
    const approvalIds = new Map<string, string>();
    for (const message of messages ?? []) {
      for (const part of Array.isArray(message.content)
        ? message.content
        : []) {
        if (part?.type === "tool-approval-request")
          approvalIds.set(part.approvalId, part.toolCall?.toolCallId);
      }
    }
    for (const message of messages ?? []) {
      for (const part of Array.isArray(message.content)
        ? message.content
        : []) {
        if (part?.type !== "tool-approval-response" || part.approved) continue;
        const toolCallId =
          part.toolCall?.toolCallId ??
          approvalIds.get(part.approvalId) ??
          approvalToolCalls.keys().next().value;
        const approval = toolCallId
          ? approvalToolCalls.get(toolCallId)
          : undefined;
        if (!approval) continue;
        approvalToolCalls.delete(toolCallId);
        await onRuntimeEvent?.("tool.rejected", {
          toolCallId,
          toolName: approval.toolName,
          message: part.reason,
        });
        await emitToolTerminal("tool.cancelled", toolCallId, {
          toolCallId,
          toolName: approval.toolName,
          completedAt: new Date().toISOString(),
        });
      }
    }
  };
  let accountedTokens = 0;
  const invokeCapability = createCapabilityInvoker({
    runtimeContext,
    resolvedPolicy,
    budget,
    durableBudget,
    strategyGuard,
    maxParallel: budget?.budget.maxParallel,
    projectResult: projectCapabilityResult,
    onEvent: async (type, payload) => {
      const toolPayload = {
        ...payload,
        toolCallId: payload.invocationId,
        toolName: payload.capabilityId,
      };
      if (type === "strategy.stalled") {
        await onRuntimeEvent?.(type, toolPayload);
        return;
      }
      const eventType = type.replace("capability.", "tool.") as
        | "tool.requested"
        | "tool.started"
        | "tool.completed"
        | "tool.failed"
        | "tool.cancelled";
      if (
        eventType === "tool.completed" ||
        eventType === "tool.failed" ||
        eventType === "tool.cancelled"
      ) {
        await emitToolTerminal(
          eventType,
          String(payload.invocationId),
          toolPayload,
        );
      } else {
        await onRuntimeEvent?.(eventType, toolPayload);
      }
    },
  });
  const guardedTools = Object.fromEntries(
    Object.entries(tools).map(([name, candidate]) => {
      if (typeof (candidate as any).execute !== "function")
        return [name, candidate];
      const original = candidate as any;
      return [
        name,
        {
          ...original,
          execute: async (args: unknown, options: any) => {
            const toolCallId = options?.toolCallId ?? options?.callId ?? name;
            const approval = approvalToolCalls.get(toolCallId);
            if (approval) {
              await onRuntimeEvent?.("tool.approved", {
                toolCallId,
                toolName: name,
              });
              approvalToolCalls.delete(toolCallId);
            }
            try {
              const result = await invokeCapability({
                capabilityId: name,
                args,
                invocationId: toolCallId,
                signal: options?.abortSignal,
                policyDecision:
                  policyDecisions.get(toolCallId) ??
                  evaluateToolCallPolicy({
                    toolName: name,
                    args,
                    runtimeContext,
                    resolvedPolicy,
                  }),
                preapproved: true,
                emitRequested: false,
                execute: (signal) =>
                  original.execute(args, {
                    ...options,
                    abortSignal: signal ?? options?.abortSignal,
                  }),
              });
              if (result.status === "blocked")
                throw new Error("APPROVAL_REQUIRED");
              return result.value;
            } finally {
              policyDecisions.delete(toolCallId);
            }
          },
        },
      ];
    }),
  );

  const agent = new ToolLoopAgent({
    model: instrumentModel(model, eventCallbacks.failActiveModelCall),
    instructions,
    tools: guardedTools,
    stopWhen: [
      isStepCount(Math.min(10, budget?.budget.maxSteps ?? 10)),
      hasToolCall("delegate_agent"),
    ],
    timeout: timeoutConfig,
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
    onLanguageModelCallStart: eventCallbacks.onLanguageModelCallStart,
    onLanguageModelCallEnd: eventCallbacks.onLanguageModelCallEnd,
    toolApproval: async ({ toolCall }) => {
      budget?.assertDuration();
      const requestedAt = Date.now();
      const pendingApproval = approvalToolCalls.has(toolCall.toolCallId);
      if (!pendingApproval)
        await onRuntimeEvent?.("tool.requested", {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          requestedAt: new Date(requestedAt).toISOString(),
        });
      const decision = evaluateToolCallPolicy({
        toolName: toolCall.toolName,
        args: (toolCall as { input?: unknown }).input,
        runtimeContext,
        resolvedPolicy,
      });
      policyDecisions.set(toolCall.toolCallId, decision);
      logger.info("policy decision", decision);
      if (decision.result === "deny") {
        await emitToolTerminal("tool.failed", toolCall.toolCallId, {
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          errorCode: "POLICY_DENIED",
          completedAt: new Date().toISOString(),
        });
        throw new Error("POLICY_DENIED");
      }
      if (decision.result === "allow") return "not-applicable";
      if (pendingApproval) return "user-approval";
      approvalToolCalls.set(toolCall.toolCallId, {
        toolName: toolCall.toolName,
        requestedAt,
      });
      await onRuntimeEvent?.("tool.approval_requested", {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      });
      return "user-approval";
    },
    onStepEnd: async ({ stepNumber, finishReason, usage }) => {
      const totalTokens = usage.totalTokens ?? 0;
      const tokens = Math.max(0, totalTokens - accountedTokens);
      await durableBudget?.charge(`step:${stepNumber}`, "steps", 1);
      await durableBudget?.charge(`tokens:${stepNumber}`, "tokens", tokens);
      budget?.afterStep({ tokens });
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
  return new Proxy(agent, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (
        (property !== "generate" && property !== "stream") ||
        typeof value !== "function"
      )
        return typeof value === "function" ? value.bind(target) : value;
      return async (options: { messages?: any[] }) => {
        await recordApprovalResponses(options.messages);
        return value.call(target, options);
      };
    },
  });
}
