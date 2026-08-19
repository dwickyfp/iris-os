import { describe, expect, it } from "vitest";
import type { OperationsConfig } from "./config";
import { evaluateReadiness } from "./readiness";
import type { OperationsSnapshot } from "./snapshot";

const config = {
  IRIS_WORKER_REQUIRED: true,
} as OperationsConfig;
const snapshot = {
  database: { migrationReady: true },
  workers: { active: 1 },
  pgBoss: { installed: true },
} as OperationsSnapshot;

describe("readiness evaluation", () => {
  it("is ready when database, migrations, worker, queue, and config pass", () => {
    expect(evaluateReadiness(config, snapshot).status).toBe("ready");
  });

  it("fails when a required worker has no current heartbeat", () => {
    const result = evaluateReadiness(config, {
      ...snapshot,
      workers: { ...snapshot.workers, active: 0 },
    });
    expect(result.status).toBe("not_ready");
    expect(result.checks.worker.ok).toBe(false);
  });

  it("does not require worker infrastructure when configured off", () => {
    const result = evaluateReadiness(
      { ...config, IRIS_WORKER_REQUIRED: false },
      {
        ...snapshot,
        workers: { ...snapshot.workers, active: 0 },
        pgBoss: { ...snapshot.pgBoss, installed: false },
      },
    );
    expect(result.status).toBe("ready");
  });
});
