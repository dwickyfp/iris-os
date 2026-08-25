import { describe, expect, test } from "vitest";
import {
  aggregateIntelligenceTelemetry,
  emptyIntelligenceTelemetry,
  projectIntelligenceMetrics,
} from "./intelligence-telemetry";

describe("intelligence telemetry", () => {
  test("aggregates intelligence outcomes without mutating observations", () => {
    const observations = [
      {
        goal: { rounds: 2, completed: false, afterContinuation: false },
        strategy: { stalls: 1, duplicates: 2 },
        steer: { latencyMs: 30 },
        scheduler: {
          activeMs: 300,
          elapsedMs: 200,
          concurrencyLimit: 2,
          peakConcurrency: 2,
        },
        context: {
          bytesBefore: 2_000,
          bytesAfter: 1_000,
          compactions: 1,
          recoveries: 0,
        },
        composition: {
          innerCalls: 3,
          modelRoundTrips: 1,
          modelRoundTripsReduced: 2,
        },
      },
      {
        goal: { rounds: 3, completed: true, afterContinuation: true },
        strategy: { stalls: 2, duplicates: 1 },
        steer: { latencyMs: 70 },
        scheduler: {
          activeMs: 100,
          elapsedMs: 100,
          concurrencyLimit: 4,
          peakConcurrency: 3,
        },
        context: {
          bytesBefore: 1_000,
          bytesAfter: 800,
          compactions: 0,
          recoveries: 1,
        },
        composition: {
          innerCalls: 2,
          modelRoundTrips: 2,
          modelRoundTripsReduced: 1,
        },
      },
    ] as const;
    const original = structuredClone(observations);

    expect(aggregateIntelligenceTelemetry(observations)).toEqual({
      goals: {
        observed: 2,
        rounds: 5,
        completed: 1,
        completedAfterContinuation: 1,
      },
      strategy: { stalls: 3, duplicates: 3 },
      steer: { observations: 2, latencyMs: 100, maxLatencyMs: 70 },
      scheduler: {
        observations: 2,
        activeMs: 400,
        capacityMs: 800,
        maxConcurrencyLimit: 4,
        peakConcurrency: 3,
      },
      context: {
        bytesBefore: 3_000,
        bytesAfter: 1_800,
        compactions: 1,
        recoveries: 1,
      },
      composition: {
        innerCalls: 5,
        modelRoundTrips: 3,
        modelRoundTripsReduced: 3,
      },
    });
    expect(observations).toEqual(original);
  });

  test("does not count an incomplete continued goal as completed", () => {
    const aggregate = aggregateIntelligenceTelemetry([
      {
        goal: { rounds: 1, completed: false, afterContinuation: true },
      },
    ]);

    expect(aggregate.goals).toEqual({
      observed: 1,
      rounds: 1,
      completed: 0,
      completedAfterContinuation: 0,
    });
  });

  test("projects a fixed label-free Prometheus metric set", () => {
    const aggregate = aggregateIntelligenceTelemetry([
      {
        goal: { rounds: 5, completed: true, afterContinuation: true },
        strategy: { stalls: 2, duplicates: 3 },
        steer: { latencyMs: 40 },
        scheduler: {
          activeMs: 150,
          elapsedMs: 100,
          concurrencyLimit: 2,
          peakConcurrency: 2,
        },
        context: {
          bytesBefore: 500,
          bytesAfter: 300,
          compactions: 1,
          recoveries: 1,
        },
        composition: {
          innerCalls: 4,
          modelRoundTrips: 2,
          modelRoundTripsReduced: 3,
        },
      },
    ]);

    const metrics = projectIntelligenceMetrics(aggregate);
    const values = Object.fromEntries(
      metrics.map((metric) => [metric.name, metric.value]),
    );

    expect(metrics).toHaveLength(20);
    expect(new Set(metrics.map(({ name }) => name)).size).toBe(metrics.length);
    expect(metrics.every((metric) => !("labels" in metric))).toBe(true);
    expect(
      metrics.every(({ name }) => /^iris_intelligence_[a-z0-9_]+$/.test(name)),
    ).toBe(true);
    expect(values).toMatchObject({
      iris_intelligence_goal_rounds_total: 5,
      iris_intelligence_goal_completions_after_continuation_total: 1,
      iris_intelligence_strategy_stalls_total: 2,
      iris_intelligence_strategy_duplicates_total: 3,
      iris_intelligence_steer_latency_seconds_average: 0.04,
      iris_intelligence_scheduler_utilization_ratio: 0.75,
      iris_intelligence_scheduler_concurrency_peak: 2,
      iris_intelligence_context_bytes_before_total: 500,
      iris_intelligence_context_bytes_after_total: 300,
      iris_intelligence_context_compactions_total: 1,
      iris_intelligence_context_recoveries_total: 1,
      iris_intelligence_composition_inner_calls_total: 4,
      iris_intelligence_composition_model_round_trips_total: 2,
      iris_intelligence_composition_model_round_trips_reduced_total: 3,
    });
  });

  test("projects finite zero-valued gauges for an empty aggregate", () => {
    const metrics = projectIntelligenceMetrics(emptyIntelligenceTelemetry());

    expect(metrics.every(({ value }) => value === 0)).toBe(true);
    expect(metrics.every(({ value }) => Number.isFinite(value))).toBe(true);
  });

  test.each([
    [{ goal: { rounds: -1, completed: false, afterContinuation: false } }],
    [{ strategy: { stalls: 0.5, duplicates: 0 } }],
    [{ steer: { latencyMs: Number.NaN } }],
    [
      {
        scheduler: {
          activeMs: 0,
          elapsedMs: 1,
          concurrencyLimit: 0,
          peakConcurrency: 0,
        },
      },
    ],
    [
      {
        context: {
          bytesBefore: 0,
          bytesAfter: -1,
          compactions: 0,
          recoveries: 0,
        },
      },
    ],
    [
      {
        composition: {
          innerCalls: 0,
          modelRoundTrips: 0,
          modelRoundTripsReduced: Number.POSITIVE_INFINITY,
        },
      },
    ],
  ])("rejects invalid telemetry %#", (observation) => {
    expect(() => aggregateIntelligenceTelemetry([observation])).toThrow(
      RangeError,
    );
  });

  test("rejects impossible scheduler telemetry", () => {
    expect(() =>
      aggregateIntelligenceTelemetry([
        {
          scheduler: {
            activeMs: 201,
            elapsedMs: 100,
            concurrencyLimit: 2,
            peakConcurrency: 2,
          },
        },
      ]),
    ).toThrow("scheduler.activeMs cannot exceed capacity");
    expect(() =>
      aggregateIntelligenceTelemetry([
        {
          scheduler: {
            activeMs: 100,
            elapsedMs: 100,
            concurrencyLimit: 2,
            peakConcurrency: 3,
          },
        },
      ]),
    ).toThrow("scheduler.peakConcurrency cannot exceed concurrencyLimit");
  });
});
