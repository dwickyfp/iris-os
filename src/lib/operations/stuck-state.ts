import { type SQL, sql } from "drizzle-orm";

/**
 * Reclaims rows that can never reach a terminal state on their own:
 * - memory_curator_run rows stuck "running" after their pg-boss retries were
 *   exhausted mid-process (the singleton job key would otherwise block a
 *   retry of the same review forever);
 * - automation_run rows stuck "awaiting_approval" that nobody approved
 *   (they are not covered by any other sweeper).
 */

export const CURATOR_RUN_STUCK_MS = 2 * 60 * 60 * 1000;
export const APPROVAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export function buildStuckCuratorRunReclaim(cutoff: Date): SQL {
  return sql`UPDATE memory_curator_run
    SET status = 'failed',
        error = 'Run stuck in running; reclaimed by recovery sweep',
        completed_at = ${cutoff},
        job_key = NULL
    WHERE status = 'running'
      AND created_at < ${cutoff}`;
}

export function buildStaleApprovalExpiry(cutoff: Date): SQL {
  return sql`UPDATE automation_run
    SET status = 'cancelled',
        error = 'Approval request expired',
        completed_at = ${cutoff}
    WHERE status = 'awaiting_approval'
      AND created_at < ${cutoff}`;
}

export type StuckStateCounts = {
  reclaimedCuratorRuns: number;
  expiredApprovalRuns: number;
};

export async function runStuckStateSweep(
  db: { execute: (query: SQL) => Promise<{ rowCount: number | null }> },
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<StuckStateCounts> {
  const envMs = (name: string, fallback: number) => {
    const raw = env[name];
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const curatorCutoff = new Date(
    now.getTime() -
      envMs("IRIS_RECOVERY_CURATOR_STUCK_MS", CURATOR_RUN_STUCK_MS),
  );
  const approvalCutoff = new Date(
    now.getTime() -
      envMs("IRIS_RECOVERY_APPROVAL_EXPIRY_MS", APPROVAL_EXPIRY_MS),
  );
  // A zero cutoff timestamp would be nonsense, so treat 0 as "disabled".
  const curator =
    curatorCutoff.getTime() >= now.getTime()
      ? { rowCount: 0 }
      : await db.execute(buildStuckCuratorRunReclaim(curatorCutoff));
  const approval =
    approvalCutoff.getTime() >= now.getTime()
      ? { rowCount: 0 }
      : await db.execute(buildStaleApprovalExpiry(approvalCutoff));
  return {
    reclaimedCuratorRuns: curator.rowCount ?? 0,
    expiredApprovalRuns: approval.rowCount ?? 0,
  };
}
