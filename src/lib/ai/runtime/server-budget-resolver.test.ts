import { describe, expect, test } from "vitest";
import { narrowServerBudget } from "./budget-resolution";

describe("server budget resolution", () => {
  test("only permits requests to narrow server limits", () => {
    expect(
      narrowServerBudget(
        { maxTokens: 10_000, maxToolCalls: 10 },
        { maxTokens: 20_000, maxToolCalls: 2 },
      ),
    ).toEqual({ maxTokens: 10_000, maxToolCalls: 2 });
  });

  test("does not let a restored duration or limit widen authority", () => {
    expect(
      narrowServerBudget(
        { maxDurationMs: 90_000, maxTokens: 10_000 },
        { maxDurationMs: 300_000, maxTokens: 20_000 },
      ),
    ).toEqual({ maxDurationMs: 90_000, maxTokens: 10_000 });
  });
});
