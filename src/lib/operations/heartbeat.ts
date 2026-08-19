import { Pool } from "pg";

export type WorkerHeartbeat = {
  workerId: string;
  hostname: string;
  pid: number;
  version: string;
};

type HeartbeatPool = Pick<Pool, "query" | "end">;

export type WorkerHeartbeatOptions = {
  maxConsecutiveFailures?: number;
  shutdownTimeoutMs?: number;
  onFailure?: (error: unknown, consecutiveFailures: number) => void;
  onShutdown?: (error: unknown) => void | Promise<void>;
  pool?: HeartbeatPool;
};

export function startWorkerHeartbeat(
  connectionString: string,
  heartbeat: WorkerHeartbeat,
  intervalMs: number,
  options: WorkerHeartbeatOptions = {},
) {
  const pool =
    options.pool ??
    new Pool({
      connectionString,
      max: 1,
      application_name: "iris-worker-heartbeat",
    });
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? 3;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  const onFailure =
    options.onFailure ??
    ((error, failures) =>
      console.error(
        `Worker heartbeat failed (${failures}/${maxConsecutiveFailures})`,
        error,
      ));
  let stopped = false;
  let consecutiveFailures = 0;
  let shutdownRequested = false;
  let pending: Promise<void> | undefined;
  const bounded = async (operation: PromiseLike<unknown>, label: string) => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        operation,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${label} timed out`)),
            shutdownTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };
  const write = () => {
    if (stopped || pending) return pending ?? Promise.resolve();
    pending = pool
      .query(
        `INSERT INTO iris_worker_heartbeat
          (worker_id, hostname, pid, version, started_at, last_heartbeat_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (worker_id) DO UPDATE SET
           hostname = EXCLUDED.hostname,
           pid = EXCLUDED.pid,
           version = EXCLUDED.version,
           last_heartbeat_at = CURRENT_TIMESTAMP`,
        [
          heartbeat.workerId,
          heartbeat.hostname,
          heartbeat.pid,
          heartbeat.version,
        ],
      )
      .then(() => undefined)
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const attempt = async () => {
    if (stopped || pending) return;
    try {
      await write();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      try {
        onFailure(error, consecutiveFailures);
      } catch (logError) {
        console.error("Worker heartbeat failure logger failed", logError);
      }
      if (
        consecutiveFailures >= maxConsecutiveFailures &&
        !shutdownRequested
      ) {
        shutdownRequested = true;
        clearInterval(timer);
        try {
          if (options.onShutdown) {
            await bounded(
              Promise.resolve(options.onShutdown(error)),
              "Worker heartbeat shutdown callback",
            );
          }
        } catch (shutdownError) {
          console.error("Worker heartbeat shutdown callback failed", shutdownError);
        }
      }
    }
  };
  const timer = setInterval(() => void attempt(), intervalMs);
  timer.unref();
  return {
    start: attempt,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      let failure: unknown;
      if (pending) {
        try {
          await bounded(pending.catch(() => undefined), "Heartbeat write");
        } catch (error) {
          failure = error;
        }
      }
      try {
        await bounded(
          pool.query(
            "DELETE FROM iris_worker_heartbeat WHERE worker_id = $1",
            [heartbeat.workerId],
          ),
          "Heartbeat cleanup",
        );
      } catch (error) {
        failure ??= error;
      } finally {
        try {
          await bounded(pool.end(), "Heartbeat pool shutdown");
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    },
  };
}
