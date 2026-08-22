import { describe, expect, it } from "vitest";
import { renderPrometheus } from "./prometheus";
import type { OperationsSnapshot } from "./snapshot";

describe("Prometheus rendering", () => {
  it("uses fixed metric names without record identifiers or labels", () => {
    const output = renderPrometheus({
      capturedAt: new Date(),
      database: { migrationReady: true },
      runs: { queued: 2, waiting_input: 1 },
      waiting: { waiting_input: 1 },
      leases: { active: 1, expired: 0 },
      outboxes: { dispatch: 3, remoteCancel: 0, parentResume: 1 },
      activity: { pending: 4 },
      verification: {
        passed: 2,
        failed: 1,
        missing: 3,
        completionFailed: 4,
      },
      budgets: {
        exhaustedRoots: 2,
        exhaustedChildren: 3,
        exhaustedRootsLastHour: 1,
        exhaustedChildrenLastHour: 2,
        expiredReservationsReleased: 5,
      },
      delegations: {
        statuses: { running: 2 },
        depths: { 1: 3 },
        activeChildren: 2,
        total: 8,
      },
      capabilityHealth: { healthy: 4, degraded: 1 },
      sandbox: {
        sessions: { active: 1 },
        executions: { timed_out: 2 },
        forcedDestroy: 3,
        sessionReaped: 7,
        timeouts: 2,
        artifactRejections: 1,
      },
      a2a: { agents: { active: 1 }, delegations: { running: 1 } },
      parentJoins: { pending: 1, completed: 2 },
      workers: { active: 1, stale: 0, oldestHeartbeatAgeSeconds: 2 },
      pgBoss: { installed: true, jobs: { created: 5 } },
    } satisfies OperationsSnapshot);
    expect(output).toContain("iris_agent_runs_waiting_input 1");
    expect(output).toContain("iris_outbox_dispatch_pending 3");
    expect(output).toContain("iris_pgboss_jobs_created 5");
    expect(output).toContain(
      "# HELP iris_budget_exhausted_roots Current root runs in the budget_exhausted state.",
    );
    expect(output).toContain("# TYPE iris_budget_exhausted_roots gauge");
    expect(output).toContain("iris_budget_exhausted_children 3");
    expect(output).toContain("iris_budget_expired_reservations_released 5");
    expect(output).toContain("# TYPE iris_delegations gauge");
    expect(output).toContain("iris_delegations 8");
    expect(output).toContain("iris_delegation_depth_1 3");
    expect(output).toContain("iris_capability_health_degraded 1");
    expect(output).toContain("iris_sandbox_executions_timed_out 2");
    expect(output).toContain("iris_sandbox_artifact_rejections 1");
    expect(output).toContain("iris_sandbox_sessions_forced_destroy 3");
    expect(output).toContain("iris_sandbox_sessions_reaped 7");
    expect(output).toContain("iris_workers_oldest_heartbeat_age_seconds 2");
    expect(output).not.toContain("# TYPE iris_delegations counter");
    expect(output).not.toMatch(
      /iris_(?:delegations|budget_exhausted|budget_expired|sandbox_sessions_(?:reaped|forced_destroy))_total/,
    );
    expect(output).not.toContain("{");
  });

  it("omits oldest heartbeat age when no worker heartbeat exists", () => {
    const snapshot = {
      capturedAt: new Date(),
      database: { migrationReady: true },
      runs: {},
      waiting: {},
      leases: { active: 0, expired: 0 },
      outboxes: { dispatch: 0, remoteCancel: 0, parentResume: 0 },
      activity: {},
      verification: {
        passed: 0,
        failed: 0,
        missing: 0,
        completionFailed: 0,
      },
      budgets: {
        exhaustedRoots: 0,
        exhaustedChildren: 0,
        exhaustedRootsLastHour: 0,
        exhaustedChildrenLastHour: 0,
        expiredReservationsReleased: 0,
      },
      delegations: { statuses: {}, depths: {}, activeChildren: 0, total: 0 },
      capabilityHealth: {},
      sandbox: {
        sessions: {},
        executions: {},
        forcedDestroy: 0,
        sessionReaped: 0,
        timeouts: 0,
        artifactRejections: 0,
      },
      a2a: { agents: {}, delegations: {} },
      parentJoins: { pending: 0, completed: 0 },
      workers: { active: 0, stale: 0, oldestHeartbeatAgeSeconds: null },
      pgBoss: { installed: false, jobs: {} },
    } satisfies OperationsSnapshot;

    expect(renderPrometheus(snapshot)).not.toContain(
      "iris_workers_oldest_heartbeat_age_seconds",
    );
  });
});
