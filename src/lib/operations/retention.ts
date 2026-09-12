import { type SQL, sql } from "drizzle-orm";

/**
 * Retention policy for append-only history tables. Without a sweeper these
 * tables grow monotonically and degrade every index that touches them.
 * Each target is disabled when its env-configured day count is <= 0.
 */
export type RetentionTarget = {
  table: string;
  column: string;
  defaultDays: number;
  envVar: string;
  /** Optional raw SQL predicate ANDed into the DELETE. */
  extraWhere?: string;
};

export const RETENTION_TARGETS: RetentionTarget[] = [
  {
    table: "iris_activity_event",
    column: "created_at",
    defaultDays: 90,
    envVar: "IRIS_RETENTION_ACTIVITY_DAYS",
  },
  {
    table: "memory_retrieval_audit",
    column: "created_at",
    defaultDays: 30,
    envVar: "IRIS_RETENTION_MEMORY_AUDIT_DAYS",
  },
  {
    table: "user_memory_event",
    column: "created_at",
    defaultDays: 180,
    envVar: "IRIS_RETENTION_MEMORY_EVENT_DAYS",
  },
  {
    table: "task_activity",
    column: "created_at",
    defaultDays: 180,
    envVar: "IRIS_RETENTION_TASK_ACTIVITY_DAYS",
  },
  {
    table: "automation_run_attempt",
    column: "started_at",
    defaultDays: 90,
    envVar: "IRIS_RETENTION_AUTOMATION_ATTEMPT_DAYS",
  },
  {
    table: "learning_promotion_attempt",
    column: "started_at",
    defaultDays: 90,
    envVar: "IRIS_RETENTION_LEARNING_ATTEMPT_DAYS",
  },
  {
    table: "system_setting_audit",
    column: "created_at",
    defaultDays: 365,
    envVar: "IRIS_RETENTION_SETTING_AUDIT_DAYS",
  },
  {
    // Terminal durable jobs are queryable history; keep a bounded window.
    table: "durable_job",
    column: "updated_at",
    defaultDays: 30,
    envVar: "IRIS_RETENTION_DURABLE_JOB_DAYS",
    extraWhere: "status IN ('completed', 'failed', 'cancelled')",
  },
  {
    table: "durable_job_completion_outbox",
    column: "delivered_at",
    defaultDays: 7,
    envVar: "IRIS_RETENTION_OUTBOX_DAYS",
    extraWhere: "delivered_at IS NOT NULL",
  },
];

export function retentionDaysFor(
  target: RetentionTarget,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[target.envVar];
  if (raw === undefined || raw === "") return target.defaultDays;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : target.defaultDays;
}

export function retentionCutoff(
  target: RetentionTarget,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): Date | undefined {
  const days = retentionDaysFor(target, env);
  if (days <= 0) return undefined;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function buildRetentionDelete(
  target: RetentionTarget,
  cutoff: Date,
): SQL {
  const predicate = target.extraWhere
    ? sql`${sql.raw(target.extraWhere)} AND `
    : sql``;
  return sql`DELETE FROM ${sql.identifier(target.table)} WHERE ${predicate}${sql.identifier(target.column)} < ${cutoff}`;
}

/** Runs one retention pass; returns deleted row counts per table. */
export async function runRetentionSweep(
  db: { execute: (query: SQL) => Promise<{ rowCount: number | null }> },
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const target of RETENTION_TARGETS) {
    const cutoff = retentionCutoff(target, now, env);
    if (!cutoff) {
      deleted[target.table] = 0;
      continue;
    }
    const result = await db.execute(buildRetentionDelete(target, cutoff));
    deleted[target.table] = result.rowCount ?? 0;
  }
  return deleted;
}
