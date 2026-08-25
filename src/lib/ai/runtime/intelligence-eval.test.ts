import { describe, expect, test } from "vitest";
import {
  type IntelligenceEvalCall,
  type IntelligenceEvalRun,
  type IntelligenceEvalScenario,
  aggregateIntelligenceEvalMetrics,
  compareIntelligenceEvalRuns,
  evaluateIntelligenceScenarios,
  measureIntelligenceEvalRun,
} from "./intelligence-eval";

const budget = {
  maxSteps: 5,
  maxModelCalls: 3,
  maxCapabilityCalls: 3,
  maxDuplicateCalls: 0,
  maxTokens: 2_000,
  maxLatencyMs: 1_000,
  maxClarifications: 1,
};

function call(
  kind: IntelligenceEvalCall["kind"],
  name: string,
  input: unknown,
  timing?: Pick<
    IntelligenceEvalCall,
    "startedAtMs" | "completedAtMs" | "concurrency" | "accepted"
  >,
): IntelligenceEvalCall {
  return { kind, name, input, ...timing };
}

function run(
  id: string,
  overrides: Partial<IntelligenceEvalRun> = {},
): IntelligenceEvalRun {
  return {
    id,
    goalSucceeded: true,
    verificationPassed: true,
    steps: 2,
    calls: [
      call("model", "planner", { goal: id }),
      call("capability", "search", { query: id }),
    ],
    tokens: 800,
    latencyMs: 400,
    clarifications: 0,
    budget,
    ...overrides,
  };
}

const scenarios: IntelligenceEvalScenario[] = [
  {
    id: "incomplete-first-attempt",
    baseline: [
      run("incomplete:baseline", {
        goalSucceeded: false,
        verificationPassed: false,
        steps: 1,
        calls: [call("model", "planner", { attempt: 1 })],
      }),
    ],
    enabled: [
      run("incomplete:enabled", {
        steps: 3,
        calls: [
          call("model", "planner", { attempt: 1 }),
          call("capability", "verify", { draft: "incomplete" }),
          call("model", "planner", { attempt: 2, feedback: "missing total" }),
        ],
        tokens: 1_200,
        latencyMs: 700,
      }),
    ],
  },
  {
    id: "loop",
    baseline: [
      run("loop:baseline", {
        goalSucceeded: false,
        verificationPassed: false,
        steps: 6,
        calls: Array.from({ length: 4 }, () =>
          call("capability", "lookup", { account: 7 }),
        ),
        tokens: 2_400,
        latencyMs: 1_200,
      }),
    ],
    enabled: [
      run("loop:enabled", {
        calls: [
          call("capability", "lookup", { account: 7 }),
          call("model", "correct-strategy", { reason: "duplicate" }),
        ],
      }),
    ],
  },
  {
    id: "steer",
    baseline: [
      run("steer:baseline", {
        goalSucceeded: false,
        verificationPassed: false,
        steps: 4,
        clarifications: 2,
        latencyMs: 1_100,
      }),
    ],
    enabled: [
      run("steer:enabled", {
        calls: [
          call("model", "planner", { revision: 1 }),
          call("capability", "report", { revision: 2 }),
        ],
        clarifications: 1,
      }),
    ],
  },
  {
    id: "stale-result",
    baseline: [
      run("stale:baseline", {
        goalSucceeded: false,
        verificationPassed: false,
        calls: [
          call("capability", "analysis", { revision: 1 }, { accepted: true }),
        ],
      }),
    ],
    enabled: [
      run("stale:enabled", {
        calls: [
          call("capability", "analysis", { revision: 1 }, { accepted: false }),
          call("capability", "analysis", { revision: 2 }, { accepted: true }),
        ],
      }),
    ],
  },
  {
    id: "large-output",
    baseline: [
      run("large:baseline", {
        steps: 4,
        tokens: 6_000,
        latencyMs: 1_400,
      }),
    ],
    enabled: [
      run("large:enabled", {
        calls: [
          call("capability", "export", { rows: 50_000 }),
          call("model", "summarize-reference", {
            byteLength: 500_000,
            resultRef: "result://large",
          }),
        ],
        tokens: 900,
      }),
    ],
  },
  {
    id: "parallel-exclusive",
    baseline: [
      run("schedule:baseline", {
        steps: 4,
        latencyMs: 900,
        calls: [
          call(
            "capability",
            "source-a",
            {},
            {
              startedAtMs: 0,
              completedAtMs: 200,
              concurrency: "exclusive",
            },
          ),
          call(
            "capability",
            "source-b",
            {},
            {
              startedAtMs: 200,
              completedAtMs: 400,
              concurrency: "exclusive",
            },
          ),
        ],
      }),
    ],
    enabled: [
      run("schedule:enabled", {
        latencyMs: 500,
        calls: [
          call(
            "capability",
            "source-a",
            {},
            {
              startedAtMs: 0,
              completedAtMs: 200,
              concurrency: "parallel",
            },
          ),
          call(
            "capability",
            "source-b",
            {},
            {
              startedAtMs: 0,
              completedAtMs: 150,
              concurrency: "parallel",
            },
          ),
          call(
            "capability",
            "commit",
            {},
            {
              startedAtMs: 200,
              completedAtMs: 250,
              concurrency: "exclusive",
            },
          ),
        ],
      }),
    ],
  },
];

describe("intelligence evaluation run measurement", () => {
  test("counts model, capability, and structurally duplicate calls", () => {
    const measured = measureIntelligenceEvalRun(
      run("duplicates", {
        calls: [
          call("model", "planner", { a: 1, b: 2 }),
          call("model", "planner", { b: 2, a: 1 }),
          call("capability", "planner", { a: 1, b: 2 }),
          call("model", "planner", { a: 2, b: 1 }),
        ],
      }),
    );

    expect(measured).toEqual({
      modelCalls: 3,
      capabilityCalls: 1,
      duplicateCalls: 1,
      budgetCompliant: false,
    });
  });

  test("derives budget compliance at inclusive boundaries", () => {
    const measured = measureIntelligenceEvalRun(
      run("at-budget", {
        steps: 5,
        calls: [
          call("model", "one", {}),
          call("model", "two", {}),
          call("model", "three", {}),
          call("capability", "one", {}),
          call("capability", "two", {}),
          call("capability", "three", {}),
        ],
        tokens: 2_000,
        latencyMs: 1_000,
        clarifications: 1,
      }),
    );

    expect(measured.budgetCompliant).toBe(true);
  });

  test("rejects malformed deterministic observations", () => {
    expect(() =>
      measureIntelligenceEvalRun(run("invalid", { tokens: Number.NaN })),
    ).toThrow("tokens must be a finite non-negative number");
    expect(() =>
      measureIntelligenceEvalRun(
        run("time-travel", {
          calls: [
            call(
              "capability",
              "work",
              {},
              {
                startedAtMs: 2,
                completedAtMs: 1,
              },
            ),
          ],
        }),
      ),
    ).toThrow("call.completedAtMs must not precede startedAtMs");
  });
});

describe("intelligence evaluation metrics", () => {
  test("aggregates every required metric without live models", () => {
    const metrics = aggregateIntelligenceEvalMetrics([
      run("success"),
      run("failure", {
        goalSucceeded: false,
        verificationPassed: false,
        steps: 6,
        calls: [
          call("model", "planner", {}),
          call("model", "planner", {}),
          call("capability", "search", {}),
        ],
        tokens: 2_400,
        latencyMs: 1_200,
        clarifications: 2,
      }),
    ]);

    expect(metrics).toEqual({
      runs: 2,
      goalSuccessRate: 0.5,
      verificationPassRate: 0.5,
      averageSteps: 4,
      averageModelCalls: 1.5,
      averageCapabilityCalls: 1,
      averageDuplicateCalls: 0.5,
      averageTokens: 1_600,
      averageLatencyMs: 800,
      averageClarifications: 1,
      budgetComplianceRate: 0.5,
    });
  });

  test("compares higher-value outcomes and lower-value resource use", () => {
    const comparison = compareIntelligenceEvalRuns(
      [run("baseline", { goalSucceeded: false, steps: 4 })],
      [run("enabled", { goalSucceeded: true, steps: 2 })],
    );

    expect(comparison.metrics.goalSuccessRate).toEqual({
      baseline: 0,
      enabled: 1,
      delta: 1,
      improvement: 1,
    });
    expect(comparison.metrics.averageSteps).toEqual({
      baseline: 4,
      enabled: 2,
      delta: -2,
      improvement: 2,
    });
    expect(comparison.improved).toContain("goalSuccessRate");
    expect(comparison.improved).toContain("averageSteps");
    expect(comparison.regressed).not.toContain("averageSteps");
  });
});

describe("deterministic Intelligence Harness fixtures", () => {
  test("covers every required deterministic behavior", () => {
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "incomplete-first-attempt",
      "loop",
      "steer",
      "stale-result",
      "large-output",
      "parallel-exclusive",
    ]);

    const staleCalls = scenarios.find((item) => item.id === "stale-result")
      ?.enabled[0].calls;
    expect(staleCalls?.map((item) => item.accepted)).toEqual([false, true]);

    const scheduledCalls = scenarios.find(
      (item) => item.id === "parallel-exclusive",
    )?.enabled[0].calls;
    expect(scheduledCalls?.map((item) => item.concurrency)).toEqual([
      "parallel",
      "parallel",
      "exclusive",
    ]);
    expect(scheduledCalls?.[0].startedAtMs).toBe(
      scheduledCalls?.[1].startedAtMs,
    );
    expect(scheduledCalls?.[2].startedAtMs).toBeGreaterThanOrEqual(
      scheduledCalls?.[0].completedAtMs ?? Infinity,
    );
  });

  test("produces deterministic per-scenario and aggregate comparisons", () => {
    const first = evaluateIntelligenceScenarios(scenarios);
    const second = evaluateIntelligenceScenarios(scenarios);

    expect(second).toEqual(first);
    expect(first.scenarios).toHaveLength(6);
    expect(first.comparison.enabled.goalSuccessRate).toBe(1);
    expect(first.comparison.enabled.verificationPassRate).toBe(1);
    expect(first.comparison.baseline.goalSuccessRate).toBe(1 / 3);
    expect(first.comparison.metrics.averageDuplicateCalls.improvement).toBe(
      0.5,
    );
    expect(first.comparison.metrics.averageTokens.improvement).toBeGreaterThan(
      0,
    );
    expect(
      first.comparison.metrics.averageLatencyMs.improvement,
    ).toBeGreaterThan(0);
    expect(
      first.comparison.metrics.budgetComplianceRate.improvement,
    ).toBeGreaterThan(0);
  });

  test("fails closed for empty suites and duplicate scenario ids", () => {
    expect(() => evaluateIntelligenceScenarios([])).toThrow(
      "At least one intelligence evaluation scenario is required",
    );
    expect(() =>
      evaluateIntelligenceScenarios([scenarios[0], scenarios[0]]),
    ).toThrow(
      "Duplicate intelligence evaluation scenario: incomplete-first-attempt",
    );
  });
});
