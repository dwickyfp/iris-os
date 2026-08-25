export type IntelligenceEvalMode = "baseline" | "enabled";

export type IntelligenceEvalBudget = {
  maxSteps?: number;
  maxModelCalls?: number;
  maxCapabilityCalls?: number;
  maxDuplicateCalls?: number;
  maxTokens?: number;
  maxLatencyMs?: number;
  maxClarifications?: number;
};

export type IntelligenceEvalCall = {
  kind: "model" | "capability";
  name: string;
  input?: unknown;
  startedAtMs?: number;
  completedAtMs?: number;
  concurrency?: "parallel" | "exclusive";
  /** False when work completed but was rejected, for example after a steer. */
  accepted?: boolean;
};

export type IntelligenceEvalRun = {
  id: string;
  goalSucceeded: boolean;
  verificationPassed: boolean;
  steps: number;
  calls: readonly IntelligenceEvalCall[];
  tokens: number;
  latencyMs: number;
  clarifications: number;
  budget?: IntelligenceEvalBudget;
};

export type IntelligenceEvalScenario = {
  id: string;
  description?: string;
  baseline: readonly IntelligenceEvalRun[];
  enabled: readonly IntelligenceEvalRun[];
};

export type IntelligenceEvalMetrics = {
  runs: number;
  goalSuccessRate: number;
  verificationPassRate: number;
  averageSteps: number;
  averageModelCalls: number;
  averageCapabilityCalls: number;
  averageDuplicateCalls: number;
  averageTokens: number;
  averageLatencyMs: number;
  averageClarifications: number;
  budgetComplianceRate: number;
};

export type IntelligenceEvalMetricName = Exclude<
  keyof IntelligenceEvalMetrics,
  "runs"
>;

export type IntelligenceEvalMetricComparison = {
  baseline: number;
  enabled: number;
  /** Raw enabled minus baseline change. */
  delta: number;
  /** Positive always means enabled is better for this metric. */
  improvement: number;
};

export type IntelligenceEvalComparison = {
  baseline: IntelligenceEvalMetrics;
  enabled: IntelligenceEvalMetrics;
  metrics: Record<IntelligenceEvalMetricName, IntelligenceEvalMetricComparison>;
  improved: IntelligenceEvalMetricName[];
  regressed: IntelligenceEvalMetricName[];
};

export type IntelligenceEvalReport = {
  scenarios: Array<
    Pick<IntelligenceEvalScenario, "id" | "description"> & {
      comparison: IntelligenceEvalComparison;
    }
  >;
  comparison: IntelligenceEvalComparison;
};

export type IntelligenceEvalRunMeasurement = {
  modelCalls: number;
  capabilityCalls: number;
  duplicateCalls: number;
  budgetCompliant: boolean;
};

const METRIC_NAMES: readonly IntelligenceEvalMetricName[] = [
  "goalSuccessRate",
  "verificationPassRate",
  "averageSteps",
  "averageModelCalls",
  "averageCapabilityCalls",
  "averageDuplicateCalls",
  "averageTokens",
  "averageLatencyMs",
  "averageClarifications",
  "budgetComplianceRate",
];

const HIGHER_IS_BETTER = new Set<IntelligenceEvalMetricName>([
  "goalSuccessRate",
  "verificationPassRate",
  "budgetComplianceRate",
]);

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalValue {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (value === Infinity) return { $number: "Infinity" };
    if (value === -Infinity) return { $number: "-Infinity" };
    if (Object.is(value, -0)) return { $number: "-0" };
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "undefined") return { $undefined: "" };
  if (typeof value === "function" || typeof value === "symbol")
    throw new TypeError(`Cannot evaluate a call containing ${typeof value}`);
  if (ancestors.has(value))
    throw new TypeError("Cannot evaluate a call containing a cyclic value");

  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => canonicalize(item, ancestors))
    : Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [
            key,
            canonicalize((value as Record<string, unknown>)[key], ancestors),
          ]),
      );
  ancestors.delete(value);
  return result;
}

function callKey(call: IntelligenceEvalCall) {
  return JSON.stringify({
    input: canonicalize(call.input, new Set()),
    kind: call.kind,
    name: call.name,
  });
}

function assertNonNegative(name: string, value: number) {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a finite non-negative number`);
}

function validateRun(run: IntelligenceEvalRun) {
  if (!run.id) throw new Error("Intelligence evaluation run id is required");
  assertNonNegative("steps", run.steps);
  assertNonNegative("tokens", run.tokens);
  assertNonNegative("latencyMs", run.latencyMs);
  assertNonNegative("clarifications", run.clarifications);
  for (const [name, limit] of Object.entries(run.budget ?? {})) {
    if (limit !== undefined) assertNonNegative(`budget.${name}`, limit);
  }
  for (const call of run.calls) {
    if (!call.name) throw new Error(`Call name is required in run ${run.id}`);
    if (call.startedAtMs !== undefined)
      assertNonNegative("call.startedAtMs", call.startedAtMs);
    if (call.completedAtMs !== undefined)
      assertNonNegative("call.completedAtMs", call.completedAtMs);
    if (
      call.startedAtMs !== undefined &&
      call.completedAtMs !== undefined &&
      call.completedAtMs < call.startedAtMs
    ) {
      throw new RangeError("call.completedAtMs must not precede startedAtMs");
    }
  }
}

function within(value: number, limit: number | undefined) {
  return limit === undefined || value <= limit;
}

export function measureIntelligenceEvalRun(
  run: IntelligenceEvalRun,
): IntelligenceEvalRunMeasurement {
  validateRun(run);
  let modelCalls = 0;
  let capabilityCalls = 0;
  let duplicateCalls = 0;
  const seen = new Set<string>();

  for (const call of run.calls) {
    if (call.kind === "model") modelCalls += 1;
    else capabilityCalls += 1;
    const key = callKey(call);
    if (seen.has(key)) duplicateCalls += 1;
    else seen.add(key);
  }

  const budget = run.budget ?? {};
  return {
    modelCalls,
    capabilityCalls,
    duplicateCalls,
    budgetCompliant:
      within(run.steps, budget.maxSteps) &&
      within(modelCalls, budget.maxModelCalls) &&
      within(capabilityCalls, budget.maxCapabilityCalls) &&
      within(duplicateCalls, budget.maxDuplicateCalls) &&
      within(run.tokens, budget.maxTokens) &&
      within(run.latencyMs, budget.maxLatencyMs) &&
      within(run.clarifications, budget.maxClarifications),
  };
}

export function aggregateIntelligenceEvalMetrics(
  runs: readonly IntelligenceEvalRun[],
): IntelligenceEvalMetrics {
  if (runs.length === 0)
    throw new Error("At least one intelligence evaluation run is required");

  const totals = {
    goals: 0,
    verifications: 0,
    steps: 0,
    modelCalls: 0,
    capabilityCalls: 0,
    duplicateCalls: 0,
    tokens: 0,
    latencyMs: 0,
    clarifications: 0,
    compliant: 0,
  };
  for (const run of runs) {
    const measured = measureIntelligenceEvalRun(run);
    totals.goals += Number(run.goalSucceeded);
    totals.verifications += Number(run.verificationPassed);
    totals.steps += run.steps;
    totals.modelCalls += measured.modelCalls;
    totals.capabilityCalls += measured.capabilityCalls;
    totals.duplicateCalls += measured.duplicateCalls;
    totals.tokens += run.tokens;
    totals.latencyMs += run.latencyMs;
    totals.clarifications += run.clarifications;
    totals.compliant += Number(measured.budgetCompliant);
  }

  const count = runs.length;
  return {
    runs: count,
    goalSuccessRate: totals.goals / count,
    verificationPassRate: totals.verifications / count,
    averageSteps: totals.steps / count,
    averageModelCalls: totals.modelCalls / count,
    averageCapabilityCalls: totals.capabilityCalls / count,
    averageDuplicateCalls: totals.duplicateCalls / count,
    averageTokens: totals.tokens / count,
    averageLatencyMs: totals.latencyMs / count,
    averageClarifications: totals.clarifications / count,
    budgetComplianceRate: totals.compliant / count,
  };
}

export function compareIntelligenceEvalRuns(
  baselineRuns: readonly IntelligenceEvalRun[],
  enabledRuns: readonly IntelligenceEvalRun[],
): IntelligenceEvalComparison {
  const baseline = aggregateIntelligenceEvalMetrics(baselineRuns);
  const enabled = aggregateIntelligenceEvalMetrics(enabledRuns);
  const metrics = {} as IntelligenceEvalComparison["metrics"];
  const improved: IntelligenceEvalMetricName[] = [];
  const regressed: IntelligenceEvalMetricName[] = [];

  for (const name of METRIC_NAMES) {
    const delta = enabled[name] - baseline[name];
    const improvement = HIGHER_IS_BETTER.has(name) ? delta : -delta;
    metrics[name] = {
      baseline: baseline[name],
      enabled: enabled[name],
      delta,
      improvement,
    };
    if (improvement > 0) improved.push(name);
    if (improvement < 0) regressed.push(name);
  }

  return { baseline, enabled, metrics, improved, regressed };
}

export function evaluateIntelligenceScenarios(
  scenarios: readonly IntelligenceEvalScenario[],
): IntelligenceEvalReport {
  if (scenarios.length === 0)
    throw new Error(
      "At least one intelligence evaluation scenario is required",
    );
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (!scenario.id)
      throw new Error("Intelligence evaluation scenario id is required");
    if (ids.has(scenario.id))
      throw new Error(
        `Duplicate intelligence evaluation scenario: ${scenario.id}`,
      );
    ids.add(scenario.id);
  }

  return {
    scenarios: scenarios.map((scenario) => ({
      id: scenario.id,
      description: scenario.description,
      comparison: compareIntelligenceEvalRuns(
        scenario.baseline,
        scenario.enabled,
      ),
    })),
    comparison: compareIntelligenceEvalRuns(
      scenarios.flatMap((scenario) => scenario.baseline),
      scenarios.flatMap((scenario) => scenario.enabled),
    ),
  };
}
