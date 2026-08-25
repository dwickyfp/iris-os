import { createHash } from "node:crypto";
import type { AgentRuntimeContext } from "../agent/runtime-context";
import type { BudgetGuard } from "./budget";
import {
  type CapabilityConcurrency,
  CapabilityScheduler,
  type CapabilitySchedulerSession,
} from "./capability-scheduler";
import type { ResolvedPolicySnapshot } from "./contracts";
import {
  type PolicyEvaluationDecision,
  destinationFromArgs,
  policyEngine,
} from "./policy-engine";
import {
  StrategyGuard,
  type StrategyGuardAttempt,
  stableNormalize,
} from "./strategy-guard";

export type DurableCapabilityBudget = {
  charge(
    token: string,
    kind: "steps" | "tokens" | "tool_calls",
    amount: number,
  ): Promise<unknown>;
};

export type CapabilityInvocationEvent =
  | "capability.requested"
  | "capability.started"
  | "capability.completed"
  | "capability.failed"
  | "capability.cancelled"
  | "strategy.stalled";

export type CapabilityPolicyResolver = (input: {
  capabilityId: string;
  args: unknown;
  runtimeContext: AgentRuntimeContext;
  resolvedPolicy?: ResolvedPolicySnapshot;
}) => PolicyEvaluationDecision | Promise<PolicyEvaluationDecision>;

export type CapabilityInvocation<TResult> = {
  capabilityId: string;
  args: unknown;
  execute: (signal?: AbortSignal) => TResult | Promise<TResult>;
  invocationId?: string;
  signal?: AbortSignal;
  concurrency?: CapabilityConcurrency;
  policyDecision?:
    | PolicyEvaluationDecision
    | (() => PolicyEvaluationDecision | Promise<PolicyEvaluationDecision>);
  preapproved?: boolean;
  emitRequested?: boolean;
};

export type CapabilityInvocationResult<TResult> =
  | { status: "completed"; invocationId: string; value: TResult }
  | {
      status: "blocked";
      invocationId: string;
      reason: "approval_required";
      decision: PolicyEvaluationDecision;
    };

export type CapabilityResultProjectionContext = {
  invocationId: string;
  capabilityId: string;
  runtimeContext: AgentRuntimeContext;
};

export type CapabilityInvokerOptions<TProjected = never> = {
  runtimeContext: AgentRuntimeContext;
  resolvedPolicy?: ResolvedPolicySnapshot;
  resolvePolicy?: CapabilityPolicyResolver;
  onEvent?: (
    type: CapabilityInvocationEvent,
    payload: Record<string, unknown>,
  ) => void | Promise<void>;
  budget?: BudgetGuard;
  durableBudget?: DurableCapabilityBudget;
  strategyGuard?: StrategyGuard;
  strategyHistory?: StrategyGuardAttempt[];
  schedulerSession?: CapabilitySchedulerSession;
  maxParallel?: number;
  projectResult?: (
    result: unknown,
    context: CapabilityResultProjectionContext,
  ) => TProjected | Promise<TProjected>;
};

export function evaluateCapabilityPolicy(input: {
  capabilityId: string;
  args: unknown;
  runtimeContext: AgentRuntimeContext;
  resolvedPolicy?: ResolvedPolicySnapshot;
}): PolicyEvaluationDecision {
  const { capabilityId, args, runtimeContext, resolvedPolicy } = input;
  const legacy = policyEngine.evaluateTool(capabilityId);
  return policyEngine.evaluate({
    actor: {
      type: runtimeContext.agentType === "custom" ? "agent" : "system",
      id: runtimeContext.agentId,
      userId: runtimeContext.userId,
    },
    capability: resolvedPolicy?.capabilities?.[capabilityId] ?? {
      id: `tool:${capabilityId}`,
      key: capabilityId,
      risks: legacy.readOnly ? ["read"] : undefined,
    },
    action: legacy.readOnly ? "read" : "execute",
    resource: `tool:${capabilityId}`,
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

export class CapabilityInvocationError extends Error {
  constructor(
    readonly code: "POLICY_DENIED" | "STRATEGY_STALLED",
    readonly invocationId: string,
  ) {
    super(code);
    this.name = "CapabilityInvocationError";
  }
}

export function createCapabilityInvoker<TProjected = never>(
  options: CapabilityInvokerOptions<TProjected>,
) {
  const history = options.strategyHistory ?? [];
  const guard = options.strategyGuard ?? new StrategyGuard();
  const maxParallel =
    options.maxParallel ??
    options.budget?.budget.maxParallel ??
    Number.MAX_SAFE_INTEGER;
  const session =
    options.schedulerSession ??
    new CapabilityScheduler(maxParallel).createSession();
  const terminal = new Set<string>();
  let sequence = 0;

  const terminalize = async (
    type: "capability.completed" | "capability.failed" | "capability.cancelled",
    invocationId: string,
    payload: Record<string, unknown>,
  ) => {
    if (terminal.has(invocationId)) return;
    terminal.add(invocationId);
    await options.onEvent?.(type, payload);
  };

  return async function invoke<TResult>(
    invocation: CapabilityInvocation<TResult>,
  ): Promise<CapabilityInvocationResult<TResult | TProjected>> {
    const invocationId =
      invocation.invocationId ??
      createHash("sha256")
        .update(
          stableNormalize({
            runId: options.runtimeContext.runId,
            capabilityId: invocation.capabilityId,
            sequence: sequence++,
          }),
        )
        .digest("hex")
        .slice(0, 24);
    const basePayload = {
      invocationId,
      capabilityId: invocation.capabilityId,
      runId: options.runtimeContext.runId,
    };
    if (invocation.emitRequested !== false) {
      await options.onEvent?.("capability.requested", {
        ...basePayload,
        requestedAt: new Date().toISOString(),
      });
    }

    const decision = invocation.policyDecision
      ? await (typeof invocation.policyDecision === "function"
          ? invocation.policyDecision()
          : invocation.policyDecision)
      : await (options.resolvePolicy ?? evaluateCapabilityPolicy)({
          capabilityId: invocation.capabilityId,
          args: invocation.args,
          runtimeContext: options.runtimeContext,
          resolvedPolicy: options.resolvedPolicy,
        });

    if (decision.result === "deny") {
      await terminalize("capability.failed", invocationId, {
        ...basePayload,
        errorCode: "POLICY_DENIED",
        completedAt: new Date().toISOString(),
      });
      throw new CapabilityInvocationError("POLICY_DENIED", invocationId);
    }
    if (decision.result === "approval" && !invocation.preapproved) {
      await terminalize("capability.failed", invocationId, {
        ...basePayload,
        errorCode: "APPROVAL_REQUIRED",
        completedAt: new Date().toISOString(),
      });
      return {
        status: "blocked",
        invocationId,
        reason: "approval_required",
        decision,
      };
    }

    const concurrency = invocation.concurrency ?? "parallel";
    const scheduled = await session.admit({
      metadata: { concurrency },
      signal: invocation.signal,
      execute: async (signal) => {
        const previous = history.at(-1);
        if (
          previous?.capabilityId === invocation.capabilityId &&
          stableNormalize(previous.args) === stableNormalize(invocation.args)
        ) {
          const strategy = guard.evaluate({
            attempt: {
              capabilityId: invocation.capabilityId,
              args: invocation.args,
              result: previous.result,
            },
            history,
          });
          if (strategy.action !== "allow") {
            await options.onEvent?.("strategy.stalled", {
              ...basePayload,
              level: strategy.level,
              duplicateCount: strategy.duplicateCount,
              corrective: strategy.corrective,
            });
            if (strategy.action === "stop") {
              throw new CapabilityInvocationError(
                "STRATEGY_STALLED",
                invocationId,
              );
            }
          }
        }

        let budgetStarted = false;
        const startedAt = Date.now();
        try {
          options.budget?.beforeTool();
          budgetStarted = true;
          await options.durableBudget?.charge(
            `tool:${invocationId}`,
            "tool_calls",
            1,
          );
          await options.onEvent?.("capability.started", {
            ...basePayload,
            startedAt: new Date(startedAt).toISOString(),
            scheduler: { concurrency, maxParallel },
          });
          signal?.throwIfAborted();
          const value = await invocation.execute(signal);
          history.push({
            capabilityId: invocation.capabilityId,
            args: invocation.args,
            result: value,
          });
          const projected = options.projectResult
            ? await options.projectResult(value, {
                invocationId,
                capabilityId: invocation.capabilityId,
                runtimeContext: options.runtimeContext,
              })
            : value;
          const completedAt = Date.now();
          await terminalize("capability.completed", invocationId, {
            ...basePayload,
            startedAt: new Date(startedAt).toISOString(),
            completedAt: new Date(completedAt).toISOString(),
            durationMs: Math.max(0, completedAt - startedAt),
          });
          return projected;
        } catch (error) {
          const completedAt = Date.now();
          await terminalize(
            signal?.aborted ? "capability.cancelled" : "capability.failed",
            invocationId,
            {
              ...basePayload,
              startedAt: new Date(startedAt).toISOString(),
              completedAt: new Date(completedAt).toISOString(),
              durationMs: Math.max(0, completedAt - startedAt),
              message: error instanceof Error ? error.message : String(error),
            },
          );
          throw error;
        } finally {
          if (budgetStarted) options.budget?.afterTool();
        }
      },
    });

    if (scheduled.status === "skipped") {
      await terminalize("capability.cancelled", invocationId, {
        ...basePayload,
        completedAt: new Date().toISOString(),
      });
      throw invocation.signal?.reason ?? new Error("CAPABILITY_CANCELLED");
    }
    if (scheduled.status === "rejected") {
      await terminalize("capability.failed", invocationId, {
        ...basePayload,
        completedAt: new Date().toISOString(),
        message:
          scheduled.error instanceof Error
            ? scheduled.error.message
            : String(scheduled.error),
      });
      throw scheduled.error;
    }
    return { status: "completed", invocationId, value: scheduled.value };
  };
}
