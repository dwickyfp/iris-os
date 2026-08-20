import { describe, expect, test } from "vitest";
import { BudgetExhaustedError, BudgetGuard } from "./budget";

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
});
