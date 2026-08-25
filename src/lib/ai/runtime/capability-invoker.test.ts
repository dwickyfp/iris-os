import { describe, expect, it, vi } from "vitest";
import { BudgetGuard } from "./budget";
import {
  CapabilityInvocationError,
  createCapabilityInvoker,
} from "./capability-invoker";
import type { PolicyEvaluationDecision } from "./policy-engine";

function runtimeContext() {
  return {
    requestId: "request-1",
    runId: "run-1",
    userId: "user-1",
    agentType: "base" as const,
    toolMode: "auto" as const,
    approvalPolicy: "never" as const,
    skills: [],
  };
}

function decision(
  result: PolicyEvaluationDecision["result"],
): PolicyEvaluationDecision {
  return {
    version: 2,
    decisionId: `decision-${result}`,
    result,
    risks: result === "allow" ? ["read"] : ["write"],
    reasons: [],
    actor: { type: "system", userId: "user-1" },
    capability: { id: "tool:search", key: "search" },
    action: "execute",
    resource: "tool:search",
    destination: { kind: "local" },
    runtime: { kind: "foreground", approvalPolicy: "never", runId: "run-1" },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("createCapabilityInvoker", () => {
  it("uses supplied policy decisions and preserves stable invocation ids", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> =
      [];
    const durableBudget = { charge: vi.fn(async () => undefined) };
    const budget = new BudgetGuard({ maxToolCalls: 1, maxParallel: 1 });
    const invoke = createCapabilityInvoker({
      runtimeContext: runtimeContext(),
      budget,
      durableBudget,
      onEvent(type, payload) {
        events.push({ type, payload });
      },
    });

    await expect(
      invoke({
        invocationId: "invocation-1",
        capabilityId: "search",
        args: { query: "iris" },
        policyDecision: decision("allow"),
        execute: async () => "ok",
      }),
    ).resolves.toEqual({
      status: "completed",
      invocationId: "invocation-1",
      value: "ok",
    });

    expect(events.map(({ type }) => type)).toEqual([
      "capability.requested",
      "capability.started",
      "capability.completed",
    ]);
    expect(
      events.every(({ payload }) => payload.invocationId === "invocation-1"),
    ).toBe(true);
    expect(events[1].payload.scheduler).toEqual({
      concurrency: "parallel",
      maxParallel: 1,
    });
    expect(durableBudget.charge).toHaveBeenCalledWith(
      "tool:invocation-1",
      "tool_calls",
      1,
    );
    expect(budget.usage.toolCalls).toBe(1);
  });

  it("resolves snapshot policy and blocks programmatic approval", async () => {
    const execute = vi.fn();
    const invoke = createCapabilityInvoker({
      runtimeContext: { ...runtimeContext(), approvalPolicy: "always" },
      resolvedPolicy: { approvalPolicy: "always", tools: {} },
    });

    await expect(
      invoke({ capabilityId: "write", args: {}, execute }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "approval_required",
      decision: { result: "approval" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails denied policy before scheduler admission and execution", async () => {
    const execute = vi.fn();
    const invoke = createCapabilityInvoker({
      runtimeContext: runtimeContext(),
    });

    await expect(
      invoke({
        capabilityId: "write",
        args: {},
        policyDecision: async () => decision("deny"),
        execute,
      }),
    ).rejects.toBeInstanceOf(CapabilityInvocationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces run-scoped maxParallel admission", async () => {
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    const admitted = deferred<void>();
    let active = 0;
    let peak = 0;
    const invoke = createCapabilityInvoker({
      runtimeContext: runtimeContext(),
      maxParallel: 2,
      resolvePolicy: () => decision("allow"),
    });
    const calls = gates.map((gate, index) =>
      invoke({
        capabilityId: `capability-${index}`,
        args: {},
        execute: async () => {
          active++;
          peak = Math.max(peak, active);
          if (active === 2) admitted.resolve();
          const value = await gate.promise;
          active--;
          return value;
        },
      }),
    );

    await admitted.promise;
    expect(active).toBe(2);
    gates[0].resolve(0);
    await Promise.resolve();
    await Promise.resolve();
    gates[1].resolve(1);
    gates[2].resolve(2);
    await Promise.all(calls);
    expect(peak).toBe(2);
  });

  it("propagates AbortSignal and emits cancelled exactly once", async () => {
    const events: string[] = [];
    const started = deferred<void>();
    const controller = new AbortController();
    const invoke = createCapabilityInvoker({
      runtimeContext: runtimeContext(),
      resolvePolicy: () => decision("allow"),
      onEvent(type) {
        events.push(type);
        if (type === "capability.started") started.resolve();
      },
    });
    const running = invoke({
      capabilityId: "wait",
      args: {},
      signal: controller.signal,
      execute: (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            {
              once: true,
            },
          );
        }),
    });
    await started.promise;
    controller.abort();

    await expect(running).rejects.toThrow("aborted");
    expect(events).toEqual([
      "capability.requested",
      "capability.started",
      "capability.cancelled",
    ]);
  });

  it("retains strategy history across invocations and stalls duplicates", async () => {
    const events: string[] = [];
    const invoke = createCapabilityInvoker({
      runtimeContext: runtimeContext(),
      resolvePolicy: () => decision("allow"),
      onEvent(type) {
        events.push(type);
      },
    });

    for (let index = 0; index < 4; index++) {
      await invoke({
        capabilityId: "search",
        args: { query: "same" },
        execute: async () => "same-result",
      });
    }
    await expect(
      invoke({
        capabilityId: "search",
        args: { query: "same" },
        execute: async () => "same-result",
      }),
    ).rejects.toThrow("STRATEGY_STALLED");
    expect(events.filter((type) => type === "strategy.stalled")).toHaveLength(
      4,
    );
  });

  it("returns a projected result while retaining raw strategy evidence", async () => {
    const strategyHistory: Array<{
      capabilityId: string;
      args: unknown;
      result: unknown;
    }> = [];
    const raw = { rows: Array.from({ length: 100 }, (_, id) => ({ id })) };
    const projected = { mode: "reference", downloadUrl: "/artifact/result" };
    const projectResult = vi.fn(async () => projected);
    const invoke = createCapabilityInvoker({
      runtimeContext: runtimeContext(),
      resolvePolicy: () => decision("allow"),
      strategyHistory,
      projectResult,
    });

    await expect(
      invoke({
        invocationId: "invocation-large",
        capabilityId: "search",
        args: { query: "iris" },
        execute: async () => raw,
      }),
    ).resolves.toEqual({
      status: "completed",
      invocationId: "invocation-large",
      value: projected,
    });
    expect(projectResult).toHaveBeenCalledWith(raw, {
      invocationId: "invocation-large",
      capabilityId: "search",
      runtimeContext: runtimeContext(),
    });
    expect(strategyHistory[0].result).toBe(raw);
  });
});
