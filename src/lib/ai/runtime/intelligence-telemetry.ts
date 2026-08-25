export type IntelligenceTelemetryObservation = {
  goal?: {
    rounds: number;
    completed: boolean;
    afterContinuation: boolean;
  };
  strategy?: {
    stalls: number;
    duplicates: number;
  };
  steer?: {
    latencyMs: number;
  };
  scheduler?: {
    /** Sum of time spent executing, across all occupied concurrency slots. */
    activeMs: number;
    elapsedMs: number;
    concurrencyLimit: number;
    peakConcurrency: number;
  };
  context?: {
    bytesBefore: number;
    bytesAfter: number;
    compactions: number;
    recoveries: number;
  };
  composition?: {
    innerCalls: number;
    modelRoundTrips: number;
    modelRoundTripsReduced: number;
  };
};

export type IntelligenceTelemetryAggregate = {
  goals: {
    observed: number;
    rounds: number;
    completed: number;
    completedAfterContinuation: number;
  };
  strategy: {
    stalls: number;
    duplicates: number;
  };
  steer: {
    observations: number;
    latencyMs: number;
    maxLatencyMs: number;
  };
  scheduler: {
    observations: number;
    activeMs: number;
    capacityMs: number;
    maxConcurrencyLimit: number;
    peakConcurrency: number;
  };
  context: {
    bytesBefore: number;
    bytesAfter: number;
    compactions: number;
    recoveries: number;
  };
  composition: {
    innerCalls: number;
    modelRoundTrips: number;
    modelRoundTripsReduced: number;
  };
};

export type IntelligenceMetric = {
  /** A fixed Prometheus-compatible name. Dynamic labels are intentionally absent. */
  name: `iris_intelligence_${string}`;
  type: "counter" | "gauge";
  help: string;
  value: number;
};

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function add(left: number, right: number, name: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${name} exceeds the safe integer range`);
  }
  return result;
}

function multiply(left: number, right: number, name: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) {
    throw new RangeError(`${name} exceeds the safe integer range`);
  }
  return result;
}

export function emptyIntelligenceTelemetry(): IntelligenceTelemetryAggregate {
  return {
    goals: {
      observed: 0,
      rounds: 0,
      completed: 0,
      completedAfterContinuation: 0,
    },
    strategy: { stalls: 0, duplicates: 0 },
    steer: { observations: 0, latencyMs: 0, maxLatencyMs: 0 },
    scheduler: {
      observations: 0,
      activeMs: 0,
      capacityMs: 0,
      maxConcurrencyLimit: 0,
      peakConcurrency: 0,
    },
    context: {
      bytesBefore: 0,
      bytesAfter: 0,
      compactions: 0,
      recoveries: 0,
    },
    composition: {
      innerCalls: 0,
      modelRoundTrips: 0,
      modelRoundTripsReduced: 0,
    },
  };
}

export function aggregateIntelligenceTelemetry(
  observations: readonly IntelligenceTelemetryObservation[],
): IntelligenceTelemetryAggregate {
  const aggregate = emptyIntelligenceTelemetry();

  for (const observation of observations) {
    if (observation.goal) {
      const rounds = nonNegativeInteger(observation.goal.rounds, "goal.rounds");
      aggregate.goals.observed = add(
        aggregate.goals.observed,
        1,
        "goals.observed",
      );
      aggregate.goals.rounds = add(
        aggregate.goals.rounds,
        rounds,
        "goals.rounds",
      );
      if (observation.goal.completed) {
        aggregate.goals.completed = add(
          aggregate.goals.completed,
          1,
          "goals.completed",
        );
        if (observation.goal.afterContinuation) {
          aggregate.goals.completedAfterContinuation = add(
            aggregate.goals.completedAfterContinuation,
            1,
            "goals.completedAfterContinuation",
          );
        }
      }
    }

    if (observation.strategy) {
      aggregate.strategy.stalls = add(
        aggregate.strategy.stalls,
        nonNegativeInteger(observation.strategy.stalls, "strategy.stalls"),
        "strategy.stalls",
      );
      aggregate.strategy.duplicates = add(
        aggregate.strategy.duplicates,
        nonNegativeInteger(
          observation.strategy.duplicates,
          "strategy.duplicates",
        ),
        "strategy.duplicates",
      );
    }

    if (observation.steer) {
      const latencyMs = nonNegativeInteger(
        observation.steer.latencyMs,
        "steer.latencyMs",
      );
      aggregate.steer.observations = add(
        aggregate.steer.observations,
        1,
        "steer.observations",
      );
      aggregate.steer.latencyMs = add(
        aggregate.steer.latencyMs,
        latencyMs,
        "steer.latencyMs",
      );
      aggregate.steer.maxLatencyMs = Math.max(
        aggregate.steer.maxLatencyMs,
        latencyMs,
      );
    }

    if (observation.scheduler) {
      const activeMs = nonNegativeInteger(
        observation.scheduler.activeMs,
        "scheduler.activeMs",
      );
      const elapsedMs = nonNegativeInteger(
        observation.scheduler.elapsedMs,
        "scheduler.elapsedMs",
      );
      const concurrencyLimit = nonNegativeInteger(
        observation.scheduler.concurrencyLimit,
        "scheduler.concurrencyLimit",
      );
      const peakConcurrency = nonNegativeInteger(
        observation.scheduler.peakConcurrency,
        "scheduler.peakConcurrency",
      );
      if (concurrencyLimit < 1) {
        throw new RangeError("scheduler.concurrencyLimit must be positive");
      }
      if (peakConcurrency > concurrencyLimit) {
        throw new RangeError(
          "scheduler.peakConcurrency cannot exceed concurrencyLimit",
        );
      }
      const capacityMs = multiply(
        elapsedMs,
        concurrencyLimit,
        "scheduler.capacityMs",
      );
      if (activeMs > capacityMs) {
        throw new RangeError("scheduler.activeMs cannot exceed capacity");
      }
      aggregate.scheduler.observations = add(
        aggregate.scheduler.observations,
        1,
        "scheduler.observations",
      );
      aggregate.scheduler.activeMs = add(
        aggregate.scheduler.activeMs,
        activeMs,
        "scheduler.activeMs",
      );
      aggregate.scheduler.capacityMs = add(
        aggregate.scheduler.capacityMs,
        capacityMs,
        "scheduler.capacityMs",
      );
      aggregate.scheduler.maxConcurrencyLimit = Math.max(
        aggregate.scheduler.maxConcurrencyLimit,
        concurrencyLimit,
      );
      aggregate.scheduler.peakConcurrency = Math.max(
        aggregate.scheduler.peakConcurrency,
        peakConcurrency,
      );
    }

    if (observation.context) {
      aggregate.context.bytesBefore = add(
        aggregate.context.bytesBefore,
        nonNegativeInteger(
          observation.context.bytesBefore,
          "context.bytesBefore",
        ),
        "context.bytesBefore",
      );
      aggregate.context.bytesAfter = add(
        aggregate.context.bytesAfter,
        nonNegativeInteger(
          observation.context.bytesAfter,
          "context.bytesAfter",
        ),
        "context.bytesAfter",
      );
      aggregate.context.compactions = add(
        aggregate.context.compactions,
        nonNegativeInteger(
          observation.context.compactions,
          "context.compactions",
        ),
        "context.compactions",
      );
      aggregate.context.recoveries = add(
        aggregate.context.recoveries,
        nonNegativeInteger(
          observation.context.recoveries,
          "context.recoveries",
        ),
        "context.recoveries",
      );
    }

    if (observation.composition) {
      aggregate.composition.innerCalls = add(
        aggregate.composition.innerCalls,
        nonNegativeInteger(
          observation.composition.innerCalls,
          "composition.innerCalls",
        ),
        "composition.innerCalls",
      );
      aggregate.composition.modelRoundTrips = add(
        aggregate.composition.modelRoundTrips,
        nonNegativeInteger(
          observation.composition.modelRoundTrips,
          "composition.modelRoundTrips",
        ),
        "composition.modelRoundTrips",
      );
      aggregate.composition.modelRoundTripsReduced = add(
        aggregate.composition.modelRoundTripsReduced,
        nonNegativeInteger(
          observation.composition.modelRoundTripsReduced,
          "composition.modelRoundTripsReduced",
        ),
        "composition.modelRoundTripsReduced",
      );
    }
  }

  return aggregate;
}

function counter(
  name: IntelligenceMetric["name"],
  help: string,
  value: number,
): IntelligenceMetric {
  return { name, type: "counter", help, value };
}

function gauge(
  name: IntelligenceMetric["name"],
  help: string,
  value: number,
): IntelligenceMetric {
  return { name, type: "gauge", help, value };
}

/** Projects a fixed-cardinality, label-free metric set suitable for Prometheus. */
export function projectIntelligenceMetrics(
  aggregate: IntelligenceTelemetryAggregate,
): readonly IntelligenceMetric[] {
  const schedulerUtilization =
    aggregate.scheduler.capacityMs === 0
      ? 0
      : aggregate.scheduler.activeMs / aggregate.scheduler.capacityMs;
  const steerLatencyAverage =
    aggregate.steer.observations === 0
      ? 0
      : aggregate.steer.latencyMs / aggregate.steer.observations;

  return [
    counter(
      "iris_intelligence_goals_observed_total",
      "Goals included in intelligence telemetry.",
      aggregate.goals.observed,
    ),
    counter(
      "iris_intelligence_goal_rounds_total",
      "Goal execution rounds.",
      aggregate.goals.rounds,
    ),
    counter(
      "iris_intelligence_goal_completions_total",
      "Completed goals.",
      aggregate.goals.completed,
    ),
    counter(
      "iris_intelligence_goal_completions_after_continuation_total",
      "Goals completed after continuation.",
      aggregate.goals.completedAfterContinuation,
    ),
    counter(
      "iris_intelligence_strategy_stalls_total",
      "Detected strategy stalls.",
      aggregate.strategy.stalls,
    ),
    counter(
      "iris_intelligence_strategy_duplicates_total",
      "Detected duplicate strategy attempts.",
      aggregate.strategy.duplicates,
    ),
    counter(
      "iris_intelligence_steer_latency_seconds_total",
      "Cumulative latency for applying user steering.",
      aggregate.steer.latencyMs / 1_000,
    ),
    counter(
      "iris_intelligence_steer_latency_observations_total",
      "User steering latency observations.",
      aggregate.steer.observations,
    ),
    gauge(
      "iris_intelligence_steer_latency_seconds_average",
      "Average latency for applying user steering.",
      steerLatencyAverage / 1_000,
    ),
    gauge(
      "iris_intelligence_steer_latency_seconds_max",
      "Maximum observed latency for applying user steering.",
      aggregate.steer.maxLatencyMs / 1_000,
    ),
    gauge(
      "iris_intelligence_scheduler_utilization_ratio",
      "Concurrency-weighted scheduler utilization from zero to one.",
      schedulerUtilization,
    ),
    gauge(
      "iris_intelligence_scheduler_concurrency_limit_max",
      "Maximum observed scheduler concurrency limit.",
      aggregate.scheduler.maxConcurrencyLimit,
    ),
    gauge(
      "iris_intelligence_scheduler_concurrency_peak",
      "Peak observed scheduler concurrency.",
      aggregate.scheduler.peakConcurrency,
    ),
    counter(
      "iris_intelligence_context_bytes_before_total",
      "Context bytes before pressure handling.",
      aggregate.context.bytesBefore,
    ),
    counter(
      "iris_intelligence_context_bytes_after_total",
      "Context bytes after pressure handling.",
      aggregate.context.bytesAfter,
    ),
    counter(
      "iris_intelligence_context_compactions_total",
      "Context compactions.",
      aggregate.context.compactions,
    ),
    counter(
      "iris_intelligence_context_recoveries_total",
      "Context overflow recoveries.",
      aggregate.context.recoveries,
    ),
    counter(
      "iris_intelligence_composition_inner_calls_total",
      "Calls executed inside composed capabilities.",
      aggregate.composition.innerCalls,
    ),
    counter(
      "iris_intelligence_composition_model_round_trips_total",
      "Model round trips used by composed capabilities.",
      aggregate.composition.modelRoundTrips,
    ),
    counter(
      "iris_intelligence_composition_model_round_trips_reduced_total",
      "Model round trips avoided by capability composition.",
      aggregate.composition.modelRoundTripsReduced,
    ),
  ];
}
