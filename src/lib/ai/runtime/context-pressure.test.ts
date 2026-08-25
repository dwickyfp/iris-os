import type { UIMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import {
  ContextPressureManager,
  estimateContextTokens,
  retryContextOverflow,
} from "./context-pressure";
import type { ContextOverflowRecoveryInput } from "./context-pressure";

function message(id: string, text: string) {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("ContextPressureManager", () => {
  test("wraps ContextEngine-compatible output with consistent diagnostics", () => {
    const manager = new ContextPressureManager({
      compactAt: 0.8,
      pruneAt: 0.95,
    });
    const context = {
      trustedInstructions: "Follow the policy",
      instructions: "Follow the policy",
      messages: [message("m1", "Complete the request")],
    };
    const toolSchemas = {
      search: {
        description: "Search records",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    };

    const result = manager.assess({
      context,
      contextWindow: 1_000,
      reservedOutputTokens: 100,
      toolSchemas,
    });

    expect(result.action).toBe("none");
    expect(result.context).toBe(context);
    expect(result.diagnostics.estimator).toBe("character_heuristic_v1");
    expect(result.diagnostics.categories).toEqual({
      instructions: estimateContextTokens(context.trustedInstructions),
      messages: estimateContextTokens(context.messages),
      toolSchema: estimateContextTokens(toolSchemas),
      reservedOutput: 100,
    });
    expect(result.diagnostics.estimatedTotalTokens).toBe(
      Object.values(result.diagnostics.categories).reduce(
        (sum, tokens) => sum + tokens,
        0,
      ),
    );
    expect(result.diagnostics.availableInputTokens).toBe(900);
  });

  test.each([
    [50, "none"],
    [85, "compact"],
    [97, "prune"],
  ] as const)("selects %s percent pressure as %s", (tokens, action) => {
    const manager = new ContextPressureManager({
      compactAt: 0.8,
      pruneAt: 0.95,
    });
    const result = manager.assess({
      context: { instructions: "", messages: [] },
      contextWindow: 100,
      components: [
        {
          id: "working-set",
          category: "messages",
          estimatedTokens: tokens,
        },
      ],
    });

    expect(result.action).toBe(action);
  });

  test("prunes deterministically without removing required goal-critical categories", () => {
    const manager = new ContextPressureManager();
    const result = manager.assess({
      context: { instructions: "", messages: [] },
      contextWindow: 101,
      requiredCategories: ["goal", "constraints"],
      components: [
        { id: "goal", category: "goal", estimatedTokens: 45, priority: 100 },
        {
          id: "constraints",
          category: "constraints",
          estimatedTokens: 35,
          priority: 100,
        },
        {
          id: "observation-b",
          category: "observations",
          estimatedTokens: 20,
          priority: 1,
        },
        {
          id: "observation-a",
          category: "observations",
          estimatedTokens: 20,
          priority: 1,
        },
      ],
    });

    expect(result.action).toBe("prune");
    expect(result.prunedComponentIds).toEqual(["observation-a"]);
    expect(result.keptComponentIds).toEqual(
      expect.arrayContaining(["goal", "constraints"]),
    );
    expect(result.diagnostics.requiredTokens).toBe(81);
    expect(result.diagnostics.projectedTokens).toBe(101);
  });

  test("rejects when required categories alone exceed the context window", () => {
    const manager = new ContextPressureManager();
    const result = manager.assess({
      context: { instructions: "", messages: [] },
      contextWindow: 100,
      reservedOutputTokens: 30,
      requiredCategories: ["goal"],
      components: [
        { id: "goal", category: "goal", estimatedTokens: 71 },
        { id: "optional", category: "observations", estimatedTokens: 20 },
      ],
    });

    expect(result.action).toBe("reject");
    expect(result.prunedComponentIds).toEqual(["optional"]);
    expect(result.keptComponentIds).toContain("goal");
    expect(result.diagnostics.requiredTokens).toBe(102);
    expect(result.diagnostics.overflowTokens).toBe(2);
  });

  test("rejects rather than silently dropping a missing required category", () => {
    const result = new ContextPressureManager().assess({
      context: { instructions: "", messages: [] },
      contextWindow: 100,
      requiredCategories: ["goal", "constraints"],
      components: [{ id: "goal", category: "goal", estimatedTokens: 10 }],
    });

    expect(result.action).toBe("reject");
    expect(result.diagnostics.missingRequiredCategories).toEqual([
      "constraints",
    ]);
    expect(result.keptComponentIds).toContain("goal");
  });

  test("uses stable object-key ordering for schema estimates", () => {
    expect(estimateContextTokens({ beta: 2, alpha: 1 })).toBe(
      estimateContextTokens({ alpha: 1, beta: 2 }),
    );
  });
});

describe("retryContextOverflow", () => {
  test("bounds recovery to compact then prune", async () => {
    const operation = vi.fn(async () => {
      throw new Error("context overflow");
    });
    const recover = vi.fn(
      async (_input: ContextOverflowRecoveryInput) => undefined,
    );

    await expect(
      retryContextOverflow({
        operation,
        recover,
        isOverflowError: () => true,
      }),
    ).rejects.toThrow("context overflow");

    expect(operation).toHaveBeenCalledTimes(3);
    expect(recover.mock.calls.map(([input]) => input.action)).toEqual([
      "compact",
      "prune",
    ]);
  });

  test("does not retry errors that are not context overflow", async () => {
    const operation = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    const recover = vi.fn();

    await expect(
      retryContextOverflow({
        operation,
        recover,
        isOverflowError: () => false,
      }),
    ).rejects.toThrow("network unavailable");

    expect(operation).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
  });
});
