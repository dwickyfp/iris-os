import type { OperationsSnapshot } from "./snapshot";

export function renderPrometheus(snapshot: OperationsSnapshot): string {
  const lines = [
    "# HELP iris_operations_snapshot_up Whether the operations snapshot succeeded.",
    "# TYPE iris_operations_snapshot_up gauge",
    "iris_operations_snapshot_up 1",
  ];
  addMap(lines, "iris_agent_runs", snapshot.runs);
  addMap(lines, "iris_agent_runs_waiting", snapshot.waiting);
  addGauge(lines, "iris_agent_run_leases_active", snapshot.leases.active);
  addGauge(lines, "iris_agent_run_leases_expired", snapshot.leases.expired);
  addGauge(lines, "iris_outbox_dispatch_pending", snapshot.outboxes.dispatch);
  addGauge(
    lines,
    "iris_outbox_remote_cancel_pending",
    snapshot.outboxes.remoteCancel,
  );
  addGauge(
    lines,
    "iris_outbox_parent_resume_pending",
    snapshot.outboxes.parentResume,
  );
  addMap(lines, "iris_activity_events", snapshot.activity);
  addGauge(
    lines,
    "iris_artifact_verifications_passed",
    snapshot.verification.passed,
  );
  addGauge(
    lines,
    "iris_artifact_verifications_failed",
    snapshot.verification.failed,
  );
  addGauge(
    lines,
    "iris_artifacts_verification_missing",
    snapshot.verification.missing,
  );
  addMap(lines, "iris_a2a_agents", snapshot.a2a.agents);
  addMap(lines, "iris_a2a_delegations", snapshot.a2a.delegations);
  addGauge(lines, "iris_parent_joins_pending", snapshot.parentJoins.pending);
  addGauge(
    lines,
    "iris_parent_joins_completed",
    snapshot.parentJoins.completed,
  );
  addGauge(lines, "iris_workers_active", snapshot.workers.active);
  addGauge(lines, "iris_workers_stale", snapshot.workers.stale);
  addGauge(lines, "iris_pgboss_installed", snapshot.pgBoss.installed ? 1 : 0);
  addMap(lines, "iris_pgboss_jobs", snapshot.pgBoss.jobs);
  return `${lines.join("\n")}\n`;
}

function addGauge(lines: string[], name: string, value: number) {
  lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
}

function addMap(
  lines: string[],
  prefix: string,
  values: Record<string, number>,
) {
  for (const [key, value] of Object.entries(values).sort()) {
    addGauge(lines, `${prefix}_${sanitizeMetricPart(key)}`, value);
  }
}

function sanitizeMetricPart(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}
