import { describe, expect, test, vi } from "vitest";
import {
  OrchestrationPlanDependencyError,
  capabilityOrchestrationPlanSchema,
  executeCapabilityOrchestrationPlan,
  parseCapabilityOrchestrationPlan,
} from "./orchestration-plan";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("capability orchestration plan", () => {
  test("validates the strict V1 declarative shape", () => {
    expect(
      capabilityOrchestrationPlanSchema.parse({
        version: 1,
        steps: [
          {
            calls: [
              {
                id: "search",
                capabilityId: "builtin:search",
                input: { query: "weather" },
              },
            ],
          },
        ],
      }),
    ).toEqual({
      version: 1,
      steps: [
        {
          calls: [
            {
              id: "search",
              capabilityId: "builtin:search",
              input: { query: "weather" },
            },
          ],
        },
      ],
    });

    expect(() =>
      capabilityOrchestrationPlanSchema.parse({
        version: 1,
        steps: [
          {
            calls: [
              {
                id: "search",
                capabilityId: "builtin:search",
                input: {},
                inputFrom: "prior",
              },
            ],
          },
        ],
      }),
    ).toThrow("A call cannot declare both input and inputFrom");
    expect(() =>
      capabilityOrchestrationPlanSchema.parse({
        version: 2,
        steps: [{ calls: [] }],
        code: "return bypassPolicy()",
      }),
    ).toThrow();
  });

  test("runs calls in parallel, steps sequentially, and returns request order", async () => {
    const first = deferred<{ value: string }>();
    const second = deferred<{ value: string }>();
    const invocations: string[] = [];
    const invoke = vi.fn(({ capabilityId }) => {
      invocations.push(capabilityId);
      if (capabilityId === "first") return first.promise;
      if (capabilityId === "second") return second.promise;
      return { value: "third" };
    });

    const execution = executeCapabilityOrchestrationPlan(
      {
        version: 1,
        steps: [
          {
            calls: [
              { id: "one", capabilityId: "first", input: null },
              { id: "two", capabilityId: "second", input: null },
            ],
          },
          { calls: [{ id: "three", capabilityId: "third" }] },
        ],
      },
      invoke,
    );

    await Promise.resolve();
    expect(invocations).toEqual(["first", "second"]);
    second.resolve({ value: "second" });
    await Promise.resolve();
    expect(invocations).toEqual(["first", "second"]);
    first.resolve({ value: "first" });

    await expect(execution).resolves.toEqual([
      { id: "one", capabilityId: "first", result: { value: "first" } },
      { id: "two", capabilityId: "second", result: { value: "second" } },
      { id: "three", capabilityId: "third", result: { value: "third" } },
    ]);
    expect(invocations).toEqual(["first", "second", "third"]);
  });

  test("resolves inputFrom to the complete prior result", async () => {
    const upstream = {
      output: { documents: ["a", "b"] },
      usage: {
        model: { inputTokens: 12, outputTokens: 4 },
        children: [{ capabilityId: "search", usage: { requests: 2 } }],
      },
    };
    const downstream = {
      output: "summary",
      usage: { model: { inputTokens: 8, outputTokens: 2 } },
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(upstream)
      .mockResolvedValueOnce(downstream);

    const results = await executeCapabilityOrchestrationPlan(
      {
        version: 1,
        steps: [
          {
            calls: [
              {
                id: "research",
                capabilityId: "research",
                input: { topic: "neutral" },
              },
            ],
          },
          {
            calls: [
              {
                id: "summarize",
                capabilityId: "summarize",
                inputFrom: "research",
              },
            ],
          },
        ],
      },
      invoke,
    );

    expect(invoke).toHaveBeenNthCalledWith(2, {
      capabilityId: "summarize",
      input: upstream,
    });
    expect(results).toEqual([
      { id: "research", capabilityId: "research", result: upstream },
      { id: "summarize", capabilityId: "summarize", result: downstream },
    ]);
    expect(results[0].result).toBe(upstream);
  });

  test("rejects missing dependencies before invoking any capability", async () => {
    const invoke = vi.fn();

    await expect(
      executeCapabilityOrchestrationPlan(
        {
          version: 1,
          steps: [
            {
              calls: [
                {
                  id: "summary",
                  capabilityId: "summarize",
                  inputFrom: "missing",
                },
              ],
            },
          ],
        },
        invoke,
      ),
    ).rejects.toThrow("Call summary depends on missing call missing");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("rejects dependency cycles before invoking any capability", async () => {
    const invoke = vi.fn();

    await expect(
      executeCapabilityOrchestrationPlan(
        {
          version: 1,
          steps: [
            {
              calls: [{ id: "one", capabilityId: "one", inputFrom: "two" }],
            },
            {
              calls: [{ id: "two", capabilityId: "two", inputFrom: "one" }],
            },
          ],
        },
        invoke,
      ),
    ).rejects.toThrow("Dependency cycle detected");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("rejects duplicate IDs and dependencies that violate step order", () => {
    expect(() =>
      parseCapabilityOrchestrationPlan({
        version: 1,
        steps: [
          {
            calls: [
              { id: "same", capabilityId: "one" },
              { id: "same", capabilityId: "two" },
            ],
          },
        ],
      }),
    ).toThrow("Duplicate call id: same");

    expect(() =>
      parseCapabilityOrchestrationPlan({
        version: 1,
        steps: [
          {
            calls: [
              { id: "one", capabilityId: "one", inputFrom: "two" },
              { id: "two", capabilityId: "two" },
            ],
          },
        ],
      }),
    ).toThrow(OrchestrationPlanDependencyError);
  });
});
