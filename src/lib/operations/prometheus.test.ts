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
      verification: { passed: 2, failed: 1, missing: 3 },
      a2a: { agents: { active: 1 }, delegations: { running: 1 } },
      parentJoins: { pending: 1, completed: 2 },
      workers: { active: 1, stale: 0, oldestHeartbeatAgeSeconds: 2 },
      pgBoss: { installed: true, jobs: { created: 5 } },
    } satisfies OperationsSnapshot);
    expect(output).toContain("iris_agent_runs_waiting_input 1");
    expect(output).toContain("iris_outbox_dispatch_pending 3");
    expect(output).toContain("iris_pgboss_jobs_created 5");
    expect(output).not.toContain("{");
  });
});
