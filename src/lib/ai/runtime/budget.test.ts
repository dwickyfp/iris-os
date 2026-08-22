import { describe, expect, test } from "vitest";
import {
  BudgetExhaustedError,
  BudgetGuard,
  isBudgetExhausted,
} from "./budget";

describe("BudgetGuard", () => {
  test("enforces steps and tokens", () => {
    const guard = new BudgetGuard({ maxSteps: 1, maxTokens: 10 });
    guard.beforeStep();
    guard.afterStep({ tokens: 10 });
    expect(() => guard.beforeStep()).toThrow(BudgetExhaustedError);
    expect(() => guard.afterStep({ tokens: 1 })).toThrow(BudgetExhaustedError);
  });

  test("enforces tools, delegations, and child aggregate allocation", () => {
    const guard = new BudgetGuard({
      maxToolCalls: 1,
      maxDelegations: 1,
      maxTokens: 100,
    });
    guard.beforeTool();
    guard.afterTool();
    expect(() => guard.beforeTool()).toThrow("maxToolCalls");
    expect(() => guard.child({ maxTokens: 101 })).toThrow("maxTokens");
  });

  test("enforces duration", () => {
    let now = 0;
    const guard = new BudgetGuard({ maxDurationMs: 5 }, undefined, () => now);
    now = 6;
    expect(() => guard.assertDuration()).toThrow("maxDurationMs");
  });

  test("tracks peak parallelism", () => {
    const guard = new BudgetGuard({ maxParallel: 2 });
    guard.beforeTool();
    guard.beforeTool();
    expect(guard.usage.parallel).toBe(2);
    expect(() => guard.beforeTool()).toThrow("maxParallel");
    guard.afterTool();
    guard.afterTool();
  });

  test("reserves worst-case compute and commits actual usage", () => {
    const guard = new BudgetGuard({ maxComputeMs: 1_000 });
    const first = guard.reserveCompute(700);

    expect(() => guard.reserveCompute(301)).toThrow(BudgetExhaustedError);
    guard.commitCompute(first, 250);

    expect(guard.usage.computeMs).toBe(250);
    expect(guard.reserveCompute(750)).toBe("compute-2");
  });

  test("releases compute reservations without consuming budget", () => {
    const guard = new BudgetGuard({ maxComputeMs: 1_000 });
    const reservation = guard.reserveCompute(700);

    expect(guard.remaining("maxComputeMs")).toBe(300);
    guard.releaseCompute(reservation);

    expect(guard.usage.computeMs).toBe(0);
    expect(guard.remaining("maxComputeMs")).toBe(1_000);
    expect(guard.reserveCompute(1_000)).toBe("compute-2");
  });

  test("holds and releases child reservations against the parent budget", () => {
    const parent = new BudgetGuard({ maxComputeMs: 1_000 });
    const child = parent.child({ maxComputeMs: 800 });
    const reservation = child.reserveCompute(700);

    expect(parent.remaining("maxComputeMs")).toBe(300);
    expect(() => parent.reserveCompute(301)).toThrow(BudgetExhaustedError);
    child.releaseCompute(reservation);
    expect(parent.remaining("maxComputeMs")).toBe(1_000);
  });
});

describe("isBudgetExhausted", () => {
  test("recognizes the concrete error and exact structured code", () => {
    expect(
      isBudgetExhausted(
        new BudgetExhaustedError("maxSteps", {
          steps: 1,
          tokens: 0,
          toolCalls: 0,
          delegations: 0,
          depth: 0,
          parallel: 0,
          cost: 0,
          durationMs: 0,
          computeMs: 0,
        }),
      ),
    ).toBe(true);
    expect(isBudgetExhausted({ code: "BUDGET_EXHAUSTED" })).toBe(true);
    expect(isBudgetExhausted(new Error("provider budget exhausted"))).toBe(
      false,
    );
  });
});
