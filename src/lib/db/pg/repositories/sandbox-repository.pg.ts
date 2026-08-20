import "server-only";

import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { BudgetExhaustedError } from "lib/ai/runtime/budget";
import type { SandboxRepository, SandboxSessionRecord } from "lib/sandbox";
import { pgDb as db } from "../db.pg";
import {
  AgentRunTable,
  AutomationRunTable,
  SandboxExecutionTable,
  SandboxRunComputeBudgetTable,
  SandboxSessionTable,
} from "../schema.pg";

const zeroUsage = {
  steps: 0,
  tokens: 0,
  toolCalls: 0,
  delegations: 0,
  depth: 0,
  parallel: 0,
  cost: 0,
  durationMs: 0,
  computeMs: 0,
};

const nonterminalStatuses: ("creating" | "active" | "destroying")[] = [
  "creating",
  "active",
  "destroying",
];
const nonterminalAgentRunStatuses = [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "waiting_external",
] as const;
const nonterminalAutomationRunStatuses = [
  "queued",
  "awaiting_approval",
  "running",
  "retry_scheduled",
] as const;

export const pgSandboxRepository: SandboxRepository = {
  async claimSession(record, creatorToken) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${record.runId}:${record.provider}`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(SandboxSessionTable)
        .where(
          and(
            eq(SandboxSessionTable.runId, record.runId),
            eq(SandboxSessionTable.provider, record.provider),
          ),
        );

      if (!(await authoritativeRunIsLive(tx, record.runId, false))) {
        return {
          session: {
            ...(existing ? normalizeSession(existing) : record),
            status: "cancelled",
            errorCode: "RUN_CANCELLED",
          },
          claimed: false,
        };
      }

      if (
        existing &&
        (existing.status === "active" ||
          existing.status === "cancelled" ||
          (existing.status === "creating" &&
            existing.expiresAt > record.createdAt))
      ) {
        return { session: normalizeSession(existing), claimed: false };
      }

      const { id: _candidateId, ...replacement } = record;
      const values = {
        ...replacement,
        providerInstanceId: null,
        creatorToken,
        status: "creating" as const,
        errorCode: null,
        destroyedAt: null,
      };
      const [session] = existing
        ? await tx
            .update(SandboxSessionTable)
            .set(values)
            .where(eq(SandboxSessionTable.id, existing.id))
            .returning()
        : await tx
            .insert(SandboxSessionTable)
            .values({ id: record.id, ...values })
            .returning();
      if (!session) throw new Error("SANDBOX_SESSION_CLAIM_FAILED");
      return { session: normalizeSession(session), claimed: true };
    });
  },
  async activateSession(
    id,
    creatorToken,
    providerInstanceId,
    expiresAt,
    profile,
  ) {
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select({ runId: SandboxSessionTable.runId })
        .from(SandboxSessionTable)
        .where(
          and(
            eq(SandboxSessionTable.id, id),
            eq(SandboxSessionTable.status, "creating"),
            eq(SandboxSessionTable.creatorToken, creatorToken),
          ),
        );
      if (!session) return false;

      if (!(await authoritativeRunIsLive(tx, session.runId, false))) {
        return false;
      }
      const rows = await tx
        .update(SandboxSessionTable)
        .set({
          status: "active",
          providerInstanceId,
          creatorToken: null,
          expiresAt,
          ...(profile ? { profile } : {}),
        })
        .where(
          and(
            eq(SandboxSessionTable.id, id),
            eq(SandboxSessionTable.status, "creating"),
            eq(SandboxSessionTable.creatorToken, creatorToken),
          ),
        )
        .returning({ id: SandboxSessionTable.id });
      return rows.length === 1;
    });
  },
  async failSessionCreation(id, creatorToken, input) {
    await db
      .update(SandboxSessionTable)
      .set({ status: "failed", creatorToken: null, ...input })
      .where(
        and(
          eq(SandboxSessionTable.id, id),
          eq(SandboxSessionTable.status, "creating"),
          eq(SandboxSessionTable.creatorToken, creatorToken),
        ),
      );
  },
  async cancelSessionsByRun(runId, provider, completedAt) {
    return cancelSessions(
      and(
        eq(SandboxSessionTable.runId, runId),
        eq(SandboxSessionTable.provider, provider),
      ),
      completedAt,
    );
  },
  async cancelSessionsByRootRun(rootRunId, provider, completedAt) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .update(SandboxSessionTable)
        .set({
          status: "cancelled",
          creatorToken: null,
          errorCode: "RUN_CANCELLED",
          destroyedAt: completedAt,
        })
        .from(AgentRunTable)
        .where(
          and(
            eq(SandboxSessionTable.runId, AgentRunTable.id),
            or(
              eq(AgentRunTable.id, rootRunId),
              eq(AgentRunTable.rootRunId, rootRunId),
            ),
            eq(SandboxSessionTable.provider, provider),
            inArray(SandboxSessionTable.status, nonterminalStatuses),
          ),
        )
        .returning({ session: SandboxSessionTable });
      await cancelExecutions(
        tx,
        rows.map(({ session }) => session.id),
        completedAt,
      );
      return rows.map(({ session }) => normalizeSession(session));
    });
  },
  async touchSession(id, lastUsedAt, expiresAt) {
    await db
      .update(SandboxSessionTable)
      .set({ lastUsedAt, expiresAt })
      .where(eq(SandboxSessionTable.id, id));
  },
  async finishSession(id, status, input = {}) {
    await db
      .update(SandboxSessionTable)
      .set({ status, ...input })
      .where(
        and(
          eq(SandboxSessionTable.id, id),
          inArray(SandboxSessionTable.status, nonterminalStatuses),
        ),
      );
  },
  async listExpiredSessions(before, limit) {
    const sessions = await db
      .select()
      .from(SandboxSessionTable)
      .where(
        and(
          inArray(SandboxSessionTable.status, nonterminalStatuses),
          lt(SandboxSessionTable.expiresAt, before),
        ),
      )
      .limit(limit);
    return sessions.map(normalizeSession);
  },
  async reserveExecution(record, maxComputeMs) {
    if (!Number.isInteger(maxComputeMs) || maxComputeMs <= 0)
      throw new RangeError("Compute budget must be positive");
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select({
          runId: SandboxSessionTable.runId,
          status: SandboxSessionTable.status,
        })
        .from(SandboxSessionTable)
        .where(eq(SandboxSessionTable.id, record.sessionId))
        .for("update");
      if (
        !session ||
        session.status !== "active" ||
        session.runId !== record.runId
      )
        return false;
      await lockRun(tx, record.runId);
      if (!(await authoritativeRunIsLive(tx, record.runId, true))) return false;
      await tx
        .insert(SandboxRunComputeBudgetTable)
        .values({ runId: record.runId, maxComputeMs })
        .onConflictDoNothing();
      await reclaimExpiredCompute(tx, record.runId);
      const [budget] = await tx
        .select()
        .from(SandboxRunComputeBudgetTable)
        .where(eq(SandboxRunComputeBudgetTable.runId, record.runId));
      if (!budget) throw new Error("SANDBOX_COMPUTE_BUDGET_NOT_FOUND");
      if (budget.maxComputeMs !== null && budget.maxComputeMs !== maxComputeMs)
        throw new Error("SANDBOX_COMPUTE_BUDGET_LIMIT_MISMATCH");
      if (
        budget.reservedComputeMs +
          budget.committedComputeMs +
          record.reservedComputeMs >
        maxComputeMs
      )
        throw new BudgetExhaustedError("maxComputeMs", {
          ...zeroUsage,
          computeMs: budget.committedComputeMs,
        });
      const updated = await tx
        .update(SandboxRunComputeBudgetTable)
        .set({
          maxComputeMs,
          reservedComputeMs: sql`${SandboxRunComputeBudgetTable.reservedComputeMs} + ${record.reservedComputeMs}`,
          updatedAt: record.reservationExpiresAt,
        })
        .where(
          and(
            eq(SandboxRunComputeBudgetTable.runId, record.runId),
            lte(
              sql`${SandboxRunComputeBudgetTable.reservedComputeMs} + ${SandboxRunComputeBudgetTable.committedComputeMs} + ${record.reservedComputeMs}`,
              maxComputeMs,
            ),
          ),
        )
        .returning({ runId: SandboxRunComputeBudgetTable.runId });
      if (updated.length !== 1)
        throw new BudgetExhaustedError("maxComputeMs", zeroUsage);
      await tx.insert(SandboxExecutionTable).values(record);
      return true;
    });
  },
  async startExecution(
    id,
    reservationToken,
    startedAt,
    settlementDeadlineAt,
  ) {
    return db.transaction(async (tx) => {
      const [execution] = await tx
        .select({
          runId: SandboxExecutionTable.runId,
          sessionId: SandboxExecutionTable.sessionId,
        })
        .from(SandboxExecutionTable)
        .where(
          and(
            eq(SandboxExecutionTable.id, id),
            eq(SandboxExecutionTable.reservationToken, reservationToken),
            eq(SandboxExecutionTable.status, "reserved"),
          ),
        );
      if (!execution) return false;
      const [session] = await tx
        .select({
          runId: SandboxSessionTable.runId,
          status: SandboxSessionTable.status,
        })
        .from(SandboxSessionTable)
        .where(eq(SandboxSessionTable.id, execution.sessionId))
        .for("update");
      if (
        !session ||
        session.status !== "active" ||
        session.runId !== execution.runId
      )
        return false;
      await lockRun(tx, execution.runId);
      if (!(await authoritativeRunIsLive(tx, execution.runId, true)))
        return false;
      const rows = await tx
        .update(SandboxExecutionTable)
        .set({ status: "running", startedAt, settlementDeadlineAt })
        .where(
          and(
            eq(SandboxExecutionTable.id, id),
            eq(SandboxExecutionTable.reservationToken, reservationToken),
            eq(SandboxExecutionTable.status, "reserved"),
            sql`EXISTS (
              SELECT 1 FROM sandbox_session session
              WHERE session.id = ${SandboxExecutionTable.sessionId}
                AND session.run_id = ${SandboxExecutionTable.runId}
                AND session.status = 'active'
            )`,
          ),
        )
        .returning({ id: SandboxExecutionTable.id });
      return rows.length === 1;
    });
  },
  async releaseExecution(id, reservationToken, input) {
    return db.transaction(async (tx) => {
      const [execution] = await tx
        .select()
        .from(SandboxExecutionTable)
        .where(
          and(
            eq(SandboxExecutionTable.id, id),
            eq(SandboxExecutionTable.reservationToken, reservationToken),
          ),
        );
      if (!execution) return false;
      await lockRun(tx, execution.runId);
      const rows = await tx
        .update(SandboxExecutionTable)
        .set(input)
        .where(
          and(
            eq(SandboxExecutionTable.id, id),
            eq(SandboxExecutionTable.reservationToken, reservationToken),
            eq(SandboxExecutionTable.status, "reserved"),
          ),
        )
        .returning({ reservedComputeMs: SandboxExecutionTable.reservedComputeMs });
      if (rows.length !== 1) return false;
      await adjustBudget(tx, execution.runId, -rows[0].reservedComputeMs, 0);
      return true;
    });
  },
  async settleExecution(
    id,
    reservationToken,
    durationMs,
    observedWallDurationMs,
    chargedAt,
  ) {
    return db.transaction(async (tx) => {
      const [execution] = await tx
        .select()
        .from(SandboxExecutionTable)
        .where(
          and(
            eq(SandboxExecutionTable.id, id),
            eq(SandboxExecutionTable.reservationToken, reservationToken),
          ),
        );
      if (!execution || !execution.startedAt) return false;
      await lockRun(tx, execution.runId);
      const charge = Math.min(
        Math.max(0, Math.ceil(durationMs)),
        execution.reservedComputeMs,
      );
      const rows = await tx
        .update(SandboxExecutionTable)
        .set({
          durationMs: charge,
          observedWallDurationMs: Math.max(
            0,
            Math.ceil(observedWallDurationMs),
          ),
          chargedAt,
        })
        .where(
          and(
            eq(SandboxExecutionTable.id, id),
            eq(SandboxExecutionTable.reservationToken, reservationToken),
            isNull(SandboxExecutionTable.chargedAt),
          ),
        )
        .returning({ id: SandboxExecutionTable.id });
      if (rows.length !== 1) return false;
      await adjustBudget(
        tx,
        execution.runId,
        -execution.reservedComputeMs,
        charge,
      );
      return true;
    });
  },
  async finishExecution(id, input) {
    const rows = await db
      .update(SandboxExecutionTable)
      .set(input)
      .where(
        and(
          eq(SandboxExecutionTable.id, id),
          eq(SandboxExecutionTable.status, "running"),
        ),
      )
      .returning({ id: SandboxExecutionTable.id });
    return rows.length === 1;
  },
  async cancelRunningExecutions(sessionId, errorCode, completedAt) {
    await db.transaction(async (tx) => {
      const executions = await tx
        .select()
        .from(SandboxExecutionTable)
        .where(
          and(
            eq(SandboxExecutionTable.sessionId, sessionId),
            inArray(SandboxExecutionTable.status, ["reserved", "running"]),
          ),
        );
      for (const runId of new Set(executions.map((row) => row.runId)))
        await lockRun(tx, runId);
      await tx
        .update(SandboxExecutionTable)
        .set({ status: "cancelled", errorCode, completedAt })
        .where(
          and(
            eq(SandboxExecutionTable.sessionId, sessionId),
            inArray(SandboxExecutionTable.status, ["reserved", "running"]),
          ),
        );
      await releaseCancelledReservations(tx, executions);
    });
  },
};

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockRun(tx: Transaction, runId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sandbox-compute:${runId}`}, 0))`,
  );
}

async function authoritativeRunIsLive(
  tx: Transaction,
  runId: string,
  requireExecutable: boolean,
) {
  const [candidate] = await tx
    .select({ rootRunId: AgentRunTable.rootRunId })
    .from(AgentRunTable)
    .where(eq(AgentRunTable.id, runId));
  if (!candidate) return false;
  const runs = await tx
    .select({
      id: AgentRunTable.id,
      rootRunId: AgentRunTable.rootRunId,
      status: AgentRunTable.status,
      cancelRequestedAt: AgentRunTable.cancelRequestedAt,
      context: AgentRunTable.context,
    })
    .from(AgentRunTable)
    .where(inArray(AgentRunTable.id, [runId, candidate.rootRunId]))
    .orderBy(AgentRunTable.id)
    .for("update");
  const run = runs.find((row) => row.id === runId);
  const root = runs.find((row) => row.id === candidate.rootRunId);
  if (
    !run ||
    !root ||
    run.cancelRequestedAt ||
    root.cancelRequestedAt ||
    !nonterminalAgentRunStatuses.includes(run.status as never) ||
    !nonterminalAgentRunStatuses.includes(root.status as never) ||
    (requireExecutable && run.status !== "running")
  )
    return false;

  const contexts = run.id === root.id ? [run.context] : [run.context, root.context];
  const automationRunIds: string[] = [];
  for (const context of contexts) {
    if (!("automationRunId" in context)) continue;
    const id = context.automationRunId;
    if (typeof id !== "string") return false;
    if (!automationRunIds.includes(id)) automationRunIds.push(id);
  }
  if (automationRunIds.length === 0) return true;
  const automationRuns = await tx
    .select({
      id: AutomationRunTable.id,
      status: AutomationRunTable.status,
      cancelRequestedAt: AutomationRunTable.cancelRequestedAt,
    })
    .from(AutomationRunTable)
    .where(inArray(AutomationRunTable.id, automationRunIds))
    .orderBy(AutomationRunTable.id)
    .for("update");
  return (
    automationRuns.length === automationRunIds.length &&
    automationRuns.every(
      (automationRun) =>
        !automationRun.cancelRequestedAt &&
        (requireExecutable
          ? automationRun.status === "running"
          : nonterminalAutomationRunStatuses.includes(
              automationRun.status as never,
            )),
    )
  );
}

async function adjustBudget(
  tx: Transaction,
  runId: string,
  reservedDelta: number,
  committedDelta: number,
) {
  await tx
    .update(SandboxRunComputeBudgetTable)
    .set({
      reservedComputeMs: sql`${SandboxRunComputeBudgetTable.reservedComputeMs} + ${reservedDelta}`,
      committedComputeMs: sql`${SandboxRunComputeBudgetTable.committedComputeMs} + ${committedDelta}`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(SandboxRunComputeBudgetTable.runId, runId));
}

async function reclaimExpiredCompute(
  tx: Transaction,
  runId: string,
) {
  const released = await tx
    .update(SandboxExecutionTable)
    .set({
      status: "failed",
      errorCode: "SANDBOX_RESERVATION_EXPIRED",
      completedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(SandboxExecutionTable.runId, runId),
        eq(SandboxExecutionTable.status, "reserved"),
        lte(SandboxExecutionTable.reservationExpiresAt, sql`CURRENT_TIMESTAMP`),
      ),
    )
    .returning({ reservedComputeMs: SandboxExecutionTable.reservedComputeMs });
  const charged = await tx
    .update(SandboxExecutionTable)
    .set({
      status: sql`CASE WHEN ${SandboxExecutionTable.status} = 'running' THEN 'timed_out' ELSE ${SandboxExecutionTable.status} END`,
      errorCode: sql`COALESCE(${SandboxExecutionTable.errorCode}, 'SANDBOX_SETTLEMENT_EXPIRED')`,
      durationMs: SandboxExecutionTable.reservedComputeMs,
      observedWallDurationMs: SandboxExecutionTable.reservedComputeMs,
      chargedAt: sql`CURRENT_TIMESTAMP`,
      completedAt: sql`COALESCE(${SandboxExecutionTable.completedAt}, CURRENT_TIMESTAMP)`,
    })
    .where(
      and(
        eq(SandboxExecutionTable.runId, runId),
        isNull(SandboxExecutionTable.chargedAt),
        lte(
          SandboxExecutionTable.settlementDeadlineAt,
          sql`CURRENT_TIMESTAMP`,
        ),
      ),
    )
    .returning({ reservedComputeMs: SandboxExecutionTable.reservedComputeMs });
  const releasedMs = released.reduce(
    (total, row) => total + row.reservedComputeMs,
    0,
  );
  const chargedMs = charged.reduce(
    (total, row) => total + row.reservedComputeMs,
    0,
  );
  if (releasedMs || chargedMs)
    await adjustBudget(tx, runId, -releasedMs - chargedMs, chargedMs);
}

async function cancelSessions(
  condition: ReturnType<typeof and>,
  completedAt: Date,
) {
  return db.transaction(async (tx) => {
    const sessions = await tx
      .update(SandboxSessionTable)
      .set({
        status: "cancelled",
        creatorToken: null,
        errorCode: "RUN_CANCELLED",
        destroyedAt: completedAt,
      })
      .where(
        and(
          condition,
          inArray(SandboxSessionTable.status, nonterminalStatuses),
        ),
      )
      .returning();
    await cancelExecutions(
      tx,
      sessions.map((session) => session.id),
      completedAt,
    );
    return sessions.map(normalizeSession);
  });
}

async function cancelExecutions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  sessionIds: string[],
  completedAt: Date,
) {
  if (sessionIds.length === 0) return;
  const executions = await tx
    .select()
    .from(SandboxExecutionTable)
    .where(
      and(
        inArray(SandboxExecutionTable.sessionId, sessionIds),
        inArray(SandboxExecutionTable.status, ["reserved", "running"]),
      ),
    );
  for (const runId of new Set(executions.map((row) => row.runId)))
    await lockRun(tx, runId);
  await tx
    .update(SandboxExecutionTable)
    .set({
      status: "cancelled",
      errorCode: "RUN_CANCELLED",
      completedAt,
    })
    .where(
      and(
        inArray(SandboxExecutionTable.sessionId, sessionIds),
        inArray(SandboxExecutionTable.status, ["reserved", "running"]),
      ),
    );
  await releaseCancelledReservations(tx, executions);
}

async function releaseCancelledReservations(
  tx: Transaction,
  executions: Array<typeof SandboxExecutionTable.$inferSelect>,
) {
  const releasedByRun = new Map<string, number>();
  for (const execution of executions) {
    if (execution.status !== "reserved") continue;
    releasedByRun.set(
      execution.runId,
      (releasedByRun.get(execution.runId) ?? 0) + execution.reservedComputeMs,
    );
  }
  for (const [runId, releasedMs] of releasedByRun)
    await adjustBudget(tx, runId, -releasedMs, 0);
}

function normalizeSession(
  session: typeof SandboxSessionTable.$inferSelect,
): SandboxSessionRecord {
  return {
    id: session.id,
    runId: session.runId,
    userId: session.userId,
    workspaceId: session.workspaceId ?? undefined,
    taskId: session.taskId ?? undefined,
    provider: session.provider,
    providerInstanceId: session.providerInstanceId ?? undefined,
    profile: session.profile,
    status: session.status,
    lastUsedAt: session.lastUsedAt,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
    errorCode: session.errorCode ?? undefined,
    destroyedAt: session.destroyedAt ?? undefined,
  };
}
