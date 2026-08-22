import type { OperationsSnapshot } from "./snapshot";

export function renderPrometheus(snapshot: OperationsSnapshot): string {
  const lines = [
    "# HELP iris_operations_snapshot_up Whether the operations snapshot succeeded.",
    "# TYPE iris_operations_snapshot_up gauge",
    "iris_operations_snapshot_up 1",
  ];
  addMap(lines, "iris_agent_runs", snapshot.runs, "Current agent runs");
  addMap(
    lines,
    "iris_agent_runs_waiting",
    snapshot.waiting,
    "Current waiting agent runs",
  );
  addGauge(
    lines,
    "iris_agent_run_leases_active",
    snapshot.leases.active,
    "Current active agent-run leases.",
  );
  addGauge(
    lines,
    "iris_agent_run_leases_expired",
    snapshot.leases.expired,
    "Current expired agent-run leases.",
  );
  addGauge(
    lines,
    "iris_outbox_dispatch_pending",
    snapshot.outboxes.dispatch,
    "Current pending dispatch outbox rows.",
  );
  addGauge(
    lines,
    "iris_outbox_remote_cancel_pending",
    snapshot.outboxes.remoteCancel,
    "Current pending remote-cancel outbox rows.",
  );
  addGauge(
    lines,
    "iris_outbox_parent_resume_pending",
    snapshot.outboxes.parentResume,
    "Current pending parent-resume outbox rows.",
  );
  addMap(
    lines,
    "iris_activity_events",
    snapshot.activity,
    "Current activity event rows",
  );
  addGauge(
    lines,
    "iris_artifact_verifications_passed",
    snapshot.verification.passed,
    "Current passed artifact verification rows.",
  );
  addGauge(
    lines,
    "iris_artifact_verifications_failed",
    snapshot.verification.failed,
    "Current failed artifact verification rows.",
  );
  addGauge(
    lines,
    "iris_artifacts_verification_missing",
    snapshot.verification.missing,
    "Current artifacts without verification rows.",
  );
  addGauge(
    lines,
    "iris_completion_verifications_failed",
    snapshot.verification.completionFailed,
    "Current durable completion-verification failure event rows.",
  );
  addGauge(
    lines,
    "iris_budget_exhausted_roots",
    snapshot.budgets.exhaustedRoots,
    "Current root runs in the budget_exhausted state.",
  );
  addGauge(
    lines,
    "iris_budget_exhausted_children",
    snapshot.budgets.exhaustedChildren,
    "Current child runs in the budget_exhausted state.",
  );
  addGauge(
    lines,
    "iris_budget_exhausted_roots_last_hour",
    snapshot.budgets.exhaustedRootsLastHour,
    "Root runs exhausted during the preceding hour.",
  );
  addGauge(
    lines,
    "iris_budget_exhausted_children_last_hour",
    snapshot.budgets.exhaustedChildrenLastHour,
    "Child runs exhausted during the preceding hour.",
  );
  addGauge(
    lines,
    "iris_budget_expired_reservations_released",
    snapshot.budgets.expiredReservationsReleased,
    "Current released budget reservations settled at or after expiry.",
  );
  addMap(
    lines,
    "iris_delegations",
    snapshot.delegations.statuses,
    "Current delegations",
  );
  addMap(
    lines,
    "iris_delegation_depth",
    snapshot.delegations.depths,
    "Current delegations at depth",
  );
  addGauge(
    lines,
    "iris_delegation_active_children",
    snapshot.delegations.activeChildren,
    "Current active delegated child runs.",
  );
  addGauge(
    lines,
    "iris_delegations",
    snapshot.delegations.total,
    "Current delegation rows.",
  );
  addMap(
    lines,
    "iris_capability_health",
    snapshot.capabilityHealth,
    "Current remote capabilities",
  );
  addMap(
    lines,
    "iris_sandbox_sessions",
    snapshot.sandbox.sessions,
    "Current sandbox sessions",
  );
  addMap(
    lines,
    "iris_sandbox_executions",
    snapshot.sandbox.executions,
    "Current sandbox executions",
  );
  addGauge(
    lines,
    "iris_sandbox_sessions_forced_destroy",
    snapshot.sandbox.forcedDestroy,
    "Current sandbox sessions with forced-destroy terminal error codes.",
  );
  addGauge(
    lines,
    "iris_sandbox_sessions_reaped",
    snapshot.sandbox.sessionReaped,
    "Current durable sandbox session-reaped event rows.",
  );
  addGauge(
    lines,
    "iris_sandbox_timeouts",
    snapshot.sandbox.timeouts,
    "Current timed-out sandbox execution rows.",
  );
  addGauge(
    lines,
    "iris_sandbox_artifact_rejections",
    snapshot.sandbox.artifactRejections,
    "Current sandbox execution rows with artifact rejection errors.",
  );
  addMap(lines, "iris_a2a_agents", snapshot.a2a.agents, "Current A2A agents");
  addMap(
    lines,
    "iris_a2a_delegations",
    snapshot.a2a.delegations,
    "Current A2A delegations",
  );
  addGauge(
    lines,
    "iris_parent_joins_pending",
    snapshot.parentJoins.pending,
    "Current pending parent joins.",
  );
  addGauge(
    lines,
    "iris_parent_joins_completed",
    snapshot.parentJoins.completed,
    "Current completed parent joins.",
  );
  addGauge(
    lines,
    "iris_workers_active",
    snapshot.workers.active,
    "Current active workers.",
  );
  addGauge(
    lines,
    "iris_workers_stale",
    snapshot.workers.stale,
    "Current stale workers.",
  );
  if (snapshot.workers.oldestHeartbeatAgeSeconds !== null) {
    addGauge(
      lines,
      "iris_workers_oldest_heartbeat_age_seconds",
      snapshot.workers.oldestHeartbeatAgeSeconds,
      "Age in seconds of the oldest worker heartbeat.",
    );
  }
  addGauge(
    lines,
    "iris_pgboss_installed",
    snapshot.pgBoss.installed ? 1 : 0,
    "Whether pg-boss is installed.",
  );
  addMap(
    lines,
    "iris_pgboss_jobs",
    snapshot.pgBoss.jobs,
    "Current pg-boss jobs",
  );
  return `${lines.join("\n")}\n`;
}

function addGauge(lines: string[], name: string, value: number, help: string) {
  lines.push(
    `# HELP ${name} ${help}`,
    `# TYPE ${name} gauge`,
    `${name} ${value}`,
  );
}

function addMap(
  lines: string[],
  prefix: string,
  values: Record<string, number>,
  help: string,
) {
  for (const [key, value] of Object.entries(values).sort()) {
    addGauge(
      lines,
      `${prefix}_${sanitizeMetricPart(key)}`,
      value,
      `${help} for ${key}.`,
    );
  }
}

function sanitizeMetricPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}
