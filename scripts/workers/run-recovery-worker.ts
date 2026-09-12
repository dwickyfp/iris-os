import { recordActivityEvent } from "lib/activity/service";
import { runManager } from "lib/ai/runs/server";
import type { AgentRun } from "lib/ai/runs/types";
import { pgDb } from "lib/db/pg/db.pg";
import logger from "lib/logger";
import { runRetentionSweep } from "lib/operations/retention";
import { runStuckStateSweep } from "lib/operations/stuck-state";
import type PgBoss from "pg-boss";

export const RUN_RECOVERY_SWEEP_QUEUE = "run-recovery-sweep";
export const RETENTION_SWEEP_QUEUE = "retention-sweep";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "budget_exhausted",
]);

/** Records the terminal activity event for a force-reaped run (idempotent). */
export async function recordReapedTerminalEvent(run: AgentRun) {
  if (!TERMINAL_STATUSES.has(run.status)) return;
  await recordActivityEvent(run.userId, {
    actorType: "system",
    scopeType: run.taskId
      ? "task"
      : run.workspaceId
        ? "workspace"
        : run.agentId
          ? "agent"
          : "global",
    scopeId: run.taskId ?? run.workspaceId ?? run.agentId ?? null,
    eventType: "run.failed",
    subjectType: "agent_run",
    subjectId: run.id,
    runId: run.id,
    taskId: run.taskId ?? undefined,
    agentId: run.agentId ?? undefined,
    payload: {
      toStatus: run.status,
      errorCode: run.errorCode ?? undefined,
      message: run.error ?? undefined,
      completedAt: (run.completedAt ?? new Date()).toISOString(),
    },
    idempotencyKey: `run-terminal:${run.id}`,
  });
}

export type RunRecoveryDeps = {
  reapStaleForegroundRuns: (limit: number) => Promise<AgentRun[]>;
  recordTerminalEvent: (run: AgentRun) => Promise<void>;
};

/** One recovery pass: force-terminalize crashed foreground runs. */
export function createRunRecoverySweep(deps: RunRecoveryDeps) {
  return async function sweep(limit = 100): Promise<number> {
    const reaped = await deps.reapStaleForegroundRuns(limit);
    for (const run of reaped) {
      try {
        await deps.recordTerminalEvent(run);
      } catch (error) {
        logger.warn("Failed to record reaped run terminal event", {
          runId: run.id,
          error,
        });
      }
    }
    return reaped.length;
  };
}

export function registerRunRecoveryWorkers(boss: PgBoss) {
  const sweep = createRunRecoverySweep({
    reapStaleForegroundRuns: (limit) =>
      runManager.reapStaleForegroundRuns(limit),
    recordTerminalEvent: recordReapedTerminalEvent,
  });
  return (async () => {
    await boss.createQueue(RUN_RECOVERY_SWEEP_QUEUE);
    await boss.work(RUN_RECOVERY_SWEEP_QUEUE, async () => {
      try {
        await sweep();
        const stuck = await runStuckStateSweep(pgDb);
        if (stuck.reclaimedCuratorRuns + stuck.expiredApprovalRuns > 0) {
          logger.info("Reclaimed stuck records", stuck);
        }
      } catch (error) {
        logger.error("Run recovery sweep failed", error);
      }
    });
    await boss.schedule(RUN_RECOVERY_SWEEP_QUEUE, "*/1 * * * *", {});

    await boss.createQueue(RETENTION_SWEEP_QUEUE);
    await boss.work(RETENTION_SWEEP_QUEUE, async () => {
      try {
        const deleted = await runRetentionSweep(pgDb);
        const total = Object.values(deleted).reduce((a, b) => a + b, 0);
        if (total > 0) logger.info("Retention sweep deleted rows", { deleted });
      } catch (error) {
        logger.error("Retention sweep failed", error);
      }
    });
    // Daily at 04:00 local server time.
    await boss.schedule(RETENTION_SWEEP_QUEUE, "0 4 * * *", {});
  })();
}
