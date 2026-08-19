import type { OperationsConfig } from "./config";
import type { OperationsSnapshot } from "./snapshot";

export type ReadinessCheck = {
  ok: boolean;
  detail?: string;
};

export type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: {
    config: ReadinessCheck;
    database: ReadinessCheck;
    migrations: ReadinessCheck;
    worker: ReadinessCheck;
    queue: ReadinessCheck;
  };
};

export function evaluateReadiness(
  config: OperationsConfig,
  snapshot: OperationsSnapshot,
): ReadinessResult {
  const workerOk = !config.IRIS_WORKER_REQUIRED || snapshot.workers.active > 0;
  const queueOk = !config.IRIS_WORKER_REQUIRED || snapshot.pgBoss.installed;
  const checks = {
    config: { ok: true },
    database: { ok: true },
    migrations: {
      ok: snapshot.database.migrationReady,
      detail: snapshot.database.migrationReady
        ? undefined
        : "migration pending",
    },
    worker: {
      ok: workerOk,
      detail: workerOk ? undefined : "no current iris-worker heartbeat",
    },
    queue: {
      ok: queueOk,
      detail: queueOk ? undefined : "pg-boss is unavailable",
    },
  };
  return {
    status: Object.values(checks).every((check) => check.ok)
      ? "ready"
      : "not_ready",
    checks,
  };
}

export function unavailableReadiness(
  check: "config" | "database",
): ReadinessResult {
  const unavailable = { ok: false, detail: "unavailable" };
  return {
    status: "not_ready",
    checks: {
      config: check === "config" ? unavailable : { ok: true },
      database:
        check === "database"
          ? unavailable
          : { ok: false, detail: "not checked" },
      migrations: { ok: false, detail: "not checked" },
      worker: { ok: false, detail: "not checked" },
      queue: { ok: false, detail: "not checked" },
    },
  };
}
