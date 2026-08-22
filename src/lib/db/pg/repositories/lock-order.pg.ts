import { eq, sql } from "drizzle-orm";
import { AgentRunTable } from "../schema.pg";

/**
 * Canonical transaction lock order for AgentRun and sandbox accounting:
 *
 * 1. Resolve stable root/run/session identities without row locks.
 * 2. Root-budget advisory lock.
 * 3. Agent-run advisory locks, then sandbox-session advisory locks, each sorted.
 * 4. Mutable agent-run, session, execution, per-run budget, reservation, and
 *    root-budget rows.
 *
 * SKIP LOCKED reapers may discover work in a short transaction, but settlement
 * must reacquire locks in this order and recheck the candidate predicates.
 */

export async function resolveRootRunId(tx: any, runId: string) {
  const [run] = await tx
    .select({ rootRunId: AgentRunTable.rootRunId })
    .from(AgentRunTable)
    .where(eq(AgentRunTable.id, runId));
  if (!run) throw new Error("ROOT_RUN_BUDGET_RUN_NOT_FOUND");
  return run.rootRunId as string;
}

export async function lockRootBudget(tx: any, rootRunId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`root-budget:${rootRunId}`}, 0))`,
  );
}

export async function lockRootBudgets(tx: any, rootRunIds: string[]) {
  for (const rootRunId of [...new Set(rootRunIds)].sort())
    await lockRootBudget(tx, rootRunId);
}

export async function lockRootBudgetForRun(tx: any, runId: string) {
  const rootRunId = await resolveRootRunId(tx, runId);
  await lockRootBudget(tx, rootRunId);
  return rootRunId;
}

export async function lockAgentRuns(tx: any, runIds: string[]) {
  for (const runId of [...new Set(runIds)].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-run:${runId}`}, 0))`,
    );
}

export async function lockSandboxSessions(tx: any, runIds: string[]) {
  for (const runId of [...new Set(runIds)].sort())
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sandbox-session:${runId}`}, 0))`,
    );
}
