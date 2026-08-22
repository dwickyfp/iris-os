import "server-only";

import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ACTIVE_AGENT_RUN_STATUSES } from "lib/ai/runs/status";
import { BudgetExhaustedError } from "lib/ai/runtime/budget";
import type { SandboxRepository, SandboxSessionRecord } from "lib/sandbox";
import { pgDb } from "../db.pg";
import {
  AgentRunTable,
  AutomationRunTable,
  RootRunBudgetReservationTable,
  RootRunBudgetTable,
  SandboxExecutionTable,
  SandboxRunComputeBudgetTable,
  SandboxSessionTable,
} from "../schema.pg";
import {
  lockAgentRuns,
  lockRootBudgetForRun,
  lockRootBudgets,
  lockSandboxSessions,
  resolveRootRunId,
} from "./lock-order.pg";

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
const nonterminalAutomationRunStatuses = [
  "queued",
  "awaiting_approval",
  "running",
  "retry_scheduled",
] as const;

export function createPgSandboxRepository(db: typeof pgDb): SandboxRepository {
  return {
    async claimSession(record, creatorToken) {
      return db.transaction(async (tx) => {
        const rootRunId = await resolveRootRunId(tx, record.runId);
        await lockRootBudgets(tx, [rootRunId]);
        await lockAgentRuns(tx, [record.runId]);
        await lockSandboxSessions(tx, [record.runId]);
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
            rootRunId,
          };
        }

        if (
          existing &&
          (existing.status === "active" ||
            existing.status === "cancelled" ||
            (existing.status === "creating" &&
              existing.expiresAt > record.createdAt))
        ) {
          return {
            session: normalizeSession(existing),
            claimed: false,
            rootRunId,
          };
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
        return { session: normalizeSession(session), claimed: true, rootRunId };
      });
    },
    async activateSession(
      id,
      creatorToken,
      providerInstanceId,
      expiresAt,
      activatedAt,
      profile,
    ) {
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ runId: SandboxSessionTable.runId })
          .from(SandboxSessionTable)
          .where(eq(SandboxSessionTable.id, id));
        if (!candidate) return false;
        await lockAccountingForExecutions(tx, [candidate.runId]);
        const [session] = await tx
          .select({
            runId: SandboxSessionTable.runId,
            status: SandboxSessionTable.status,
            providerInstanceId: SandboxSessionTable.providerInstanceId,
            creatorToken: SandboxSessionTable.creatorToken,
          })
          .from(SandboxSessionTable)
          .where(eq(SandboxSessionTable.id, id))
          .for("update");
        // Serialize creator activation with reconciliation takeover.
        // Cancellation is fenced by the authoritative run locks below.
        if (!session) return false;
        if (session.status === "active")
          return session.providerInstanceId === providerInstanceId;
        if (
          session.status !== "creating" ||
          session.creatorToken !== creatorToken
        )
          return false;

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
            lastUsedAt: activatedAt,
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
        db,
        and(
          eq(SandboxSessionTable.runId, runId),
          eq(SandboxSessionTable.provider, provider),
        ),
        completedAt,
      );
    },
    async cancelSessionsByRootRun(rootRunId, provider, completedAt) {
      return db.transaction(async (tx) => {
        const candidates = await tx
          .select({
            id: SandboxSessionTable.id,
            runId: SandboxSessionTable.runId,
          })
          .from(SandboxSessionTable)
          .innerJoin(
            AgentRunTable,
            eq(SandboxSessionTable.runId, AgentRunTable.id),
          )
          .where(
            and(
              or(
                eq(AgentRunTable.id, rootRunId),
                eq(AgentRunTable.rootRunId, rootRunId),
              ),
              eq(SandboxSessionTable.provider, provider),
              inArray(SandboxSessionTable.status, nonterminalStatuses),
            ),
          );
        await lockRootBudgets(tx, [rootRunId]);
        await lockAgentRuns(
          tx,
          candidates.map((candidate) => candidate.runId),
        );
        await lockSandboxSessions(
          tx,
          candidates.map((candidate) => candidate.runId),
        );
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
      const rows = await db
        .update(SandboxSessionTable)
        .set({ lastUsedAt, expiresAt })
        .where(
          and(
            eq(SandboxSessionTable.id, id),
            eq(SandboxSessionTable.status, "active"),
          ),
        )
        .returning({ id: SandboxSessionTable.id });
      return rows.length === 1;
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
    async claimExpiredSessions(before, limit, retryAt) {
      if (!Number.isInteger(limit) || limit <= 0)
        throw new RangeError("Session claim limit must be positive");
      return db.transaction(async (tx) => {
        const candidates = await tx
          .select()
          .from(SandboxSessionTable)
          .where(
            and(
              inArray(SandboxSessionTable.status, ["active", "destroying"]),
              lt(SandboxSessionTable.expiresAt, before),
              sql`NOT EXISTS (
              SELECT 1 FROM ${SandboxExecutionTable} execution
              WHERE execution.session_id = ${SandboxSessionTable.id}
                AND execution.status IN ('reserved', 'running')
            )`,
            ),
          )
          .orderBy(SandboxSessionTable.expiresAt, SandboxSessionTable.id)
          .limit(limit)
          .for("update", { skipLocked: true });
        const claimed: SandboxSessionRecord[] = [];
        for (const candidate of candidates) {
          const rows = await tx
            .update(SandboxSessionTable)
            .set({ status: "destroying", expiresAt: retryAt })
            .where(
              and(
                eq(SandboxSessionTable.id, candidate.id),
                eq(SandboxSessionTable.status, candidate.status),
                eq(SandboxSessionTable.expiresAt, candidate.expiresAt),
                eq(SandboxSessionTable.lastUsedAt, candidate.lastUsedAt),
              ),
            )
            .returning();
          if (rows.length === 1) claimed.push(normalizeSession(rows[0]));
        }
        return claimed;
      });
    },
    async listSessionsForReconciliation(provider, providerInstanceIds) {
      const conditions = [
        inArray(SandboxSessionTable.status, ["creating", "active"]),
      ];
      if (providerInstanceIds.length > 0) {
        conditions.push(
          inArray(SandboxSessionTable.providerInstanceId, providerInstanceIds),
        );
      }
      const sessions = await db
        .select({
          session: SandboxSessionTable,
          rootRunId: AgentRunTable.rootRunId,
        })
        .from(SandboxSessionTable)
        .innerJoin(
          AgentRunTable,
          eq(SandboxSessionTable.runId, AgentRunTable.id),
        )
        .where(
          and(eq(SandboxSessionTable.provider, provider), or(...conditions)),
        );
      return sessions.map(({ session, rootRunId }) => ({
        ...normalizeSession(session),
        rootRunId,
      }));
    },
    async reconcileSession(input) {
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ runId: SandboxSessionTable.runId })
          .from(SandboxSessionTable)
          .where(eq(SandboxSessionTable.id, input.id));
        if (!candidate) return "rejected";
        await lockAccountingForExecutions(tx, [candidate.runId]);
        const [session] = await tx
          .select()
          .from(SandboxSessionTable)
          .where(eq(SandboxSessionTable.id, input.id))
          .for("update");
        if (
          !session ||
          session.provider !== input.provider ||
          !["creating", "active"].includes(session.status) ||
          session.profile.id !== input.profile.id ||
          session.profile.network !== input.profile.network
        )
          return "rejected";

        const [run] = await tx
          .select({ rootRunId: AgentRunTable.rootRunId })
          .from(AgentRunTable)
          .where(eq(AgentRunTable.id, session.runId));
        if (
          !run ||
          run.rootRunId !== input.rootRunId ||
          !(await authoritativeRunIsLive(tx, session.runId, false))
        )
          return "rejected";

        if (session.status === "active") {
          if (session.providerInstanceId !== input.providerInstanceId)
            return "rejected";
          await tx
            .update(SandboxSessionTable)
            .set({ profile: input.profile, expiresAt: input.expiresAt })
            .where(eq(SandboxSessionTable.id, input.id));
          return "active";
        }

        if (input.creatorMayBeLive && session.expiresAt > input.reconciledAt)
          return "creator_owned";

        const activated = await tx
          .update(SandboxSessionTable)
          .set({
            status: "active",
            providerInstanceId: input.providerInstanceId,
            creatorToken: null,
            profile: input.profile,
            expiresAt: input.expiresAt,
          })
          .where(
            and(
              eq(SandboxSessionTable.id, input.id),
              eq(SandboxSessionTable.status, "creating"),
            ),
          )
          .returning({ id: SandboxSessionTable.id });
        return activated.length === 1 ? "active" : "rejected";
      });
    },
    async retainSessionAfterLookup(input) {
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ runId: SandboxSessionTable.runId })
          .from(SandboxSessionTable)
          .where(eq(SandboxSessionTable.id, input.id));
        if (!candidate) return false;
        await lockAccountingForExecutions(tx, [candidate.runId]);
        const [session] = await tx
          .select()
          .from(SandboxSessionTable)
          .where(eq(SandboxSessionTable.id, input.id))
          .for("update");
        if (
          !session ||
          session.status !== "active" ||
          session.provider !== input.provider ||
          session.providerInstanceId !== input.providerInstanceId ||
          session.profile.id !== input.profile.id ||
          session.profile.network !== input.profile.network
        )
          return false;
        const [run] = await tx
          .select({ rootRunId: AgentRunTable.rootRunId })
          .from(AgentRunTable)
          .where(eq(AgentRunTable.id, session.runId));
        return (
          run?.rootRunId === input.rootRunId &&
          (await authoritativeRunIsLive(tx, session.runId, false))
        );
      });
    },
    async markSessionLost(
      id,
      providerInstanceId,
      reconciliationStartedAt,
      completedAt,
    ) {
      return db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ runId: SandboxSessionTable.runId })
          .from(SandboxSessionTable)
          .where(eq(SandboxSessionTable.id, id));
        if (!candidate) return false;
        await lockAccountingForExecutions(tx, [candidate.runId]);
        const sessions = await tx
          .update(SandboxSessionTable)
          .set({
            status: "failed",
            creatorToken: null,
            errorCode: "SANDBOX_SESSION_LOST",
            destroyedAt: completedAt,
          })
          .where(
            and(
              eq(SandboxSessionTable.id, id),
              eq(SandboxSessionTable.status, "active"),
              eq(SandboxSessionTable.providerInstanceId, providerInstanceId),
              lte(SandboxSessionTable.createdAt, reconciliationStartedAt),
              lte(SandboxSessionTable.lastUsedAt, reconciliationStartedAt),
            ),
          )
          .returning({ id: SandboxSessionTable.id });
        if (sessions.length !== 1) return false;
        await terminalizeLostExecutions(tx, id, completedAt);
        return true;
      });
    },
    async reconcileStaleExecutions(before, limit) {
      if (!Number.isInteger(limit) || limit <= 0)
        throw new RangeError("Reconciliation limit must be positive");
      let reconciled = 0;
      while (reconciled < limit) {
        const candidates = await db.transaction(async (tx) => {
          const claimed = await tx.execute<{
            id: string;
            run_id: string;
          }>(sql`
          SELECT session.id, session.run_id
          FROM ${SandboxSessionTable} session
          JOIN ${AgentRunTable} run ON run.id = session.run_id
          WHERE EXISTS (
            SELECT 1 FROM ${SandboxExecutionTable} execution
            JOIN ${RootRunBudgetReservationTable} reservation
              ON reservation.token = 'sandbox:' || execution.reservation_token::text
             AND reservation.run_id = execution.run_id
             AND reservation.state = 'reserved'
            WHERE execution.session_id = session.id
              AND ((execution.status = 'reserved'
                    AND execution.reservation_expires_at <= ${before})
                OR (execution.charged_at IS NULL
                    AND execution.status = 'running'
                    AND execution.settlement_deadline_at <= ${before})
                OR (execution.charged_at IS NULL
                    AND execution.status NOT IN ('reserved', 'running')
                    AND execution.started_at IS NOT NULL))
          )
          ORDER BY run.root_run_id, session.id
          FOR UPDATE OF session SKIP LOCKED
          LIMIT ${limit - reconciled}
        `);
          return claimed.rows;
        });
        let settled = 0;
        for (const candidate of candidates) {
          if (reconciled + settled >= limit) break;
          settled += await db.transaction(async (tx) => {
            await lockRootBudgetForRun(tx, candidate.run_id);
            await lockAgentRuns(tx, [candidate.run_id]);
            await lockSandboxSessions(tx, [candidate.run_id]);
            const executions = await tx
              .select()
              .from(SandboxExecutionTable)
              .where(
                and(
                  eq(SandboxExecutionTable.sessionId, candidate.id),
                  sql`EXISTS (
                  SELECT 1 FROM ${RootRunBudgetReservationTable} reservation
                  WHERE reservation.token = 'sandbox:' || ${SandboxExecutionTable.reservationToken}::text
                    AND reservation.run_id = ${SandboxExecutionTable.runId}
                    AND reservation.state = 'reserved'
                )`,
                  or(
                    and(
                      eq(SandboxExecutionTable.status, "reserved"),
                      lte(SandboxExecutionTable.reservationExpiresAt, before),
                    ),
                    and(
                      isNull(SandboxExecutionTable.chargedAt),
                      eq(SandboxExecutionTable.status, "running"),
                      lte(SandboxExecutionTable.settlementDeadlineAt, before),
                    ),
                    and(
                      isNull(SandboxExecutionTable.chargedAt),
                      sql`${SandboxExecutionTable.status} NOT IN ('reserved', 'running')`,
                      sql`${SandboxExecutionTable.startedAt} IS NOT NULL`,
                    ),
                  ),
                ),
              )
              .orderBy(SandboxExecutionTable.id)
              .limit(limit - reconciled - settled)
              .for("update", { skipLocked: true });
            let changed = 0;
            for (const execution of executions) {
              const started = execution.startedAt !== null;
              const status =
                execution.status === "running"
                  ? "timed_out"
                  : execution.status === "reserved"
                    ? "failed"
                    : execution.status;
              const charge = started ? execution.reservedComputeMs : null;
              const rows = await tx
                .update(SandboxExecutionTable)
                .set({
                  status,
                  errorCode: started
                    ? "SANDBOX_SETTLEMENT_EXPIRED"
                    : "SANDBOX_RESERVATION_EXPIRED",
                  durationMs: charge,
                  observedWallDurationMs: charge,
                  chargedAt: started ? before : null,
                  completedAt: before,
                })
                .where(
                  and(
                    eq(SandboxExecutionTable.id, execution.id),
                    isNull(SandboxExecutionTable.chargedAt),
                  ),
                )
                .returning({ id: SandboxExecutionTable.id });
              if (rows.length !== 1) continue;
              await adjustBudget(
                tx,
                execution.runId,
                -execution.reservedComputeMs,
                charge ?? 0,
              );
              await settleRootCompute(
                tx,
                execution.runId,
                execution.reservationToken,
                charge,
              );
              changed += 1;
            }
            return changed;
          });
        }
        if (settled === 0) break;
        reconciled += settled;
      }
      return reconciled;
    },
    async reserveExecution(record, maxComputeMs) {
      if (!Number.isInteger(maxComputeMs) || maxComputeMs <= 0)
        throw new RangeError("Compute budget must be positive");
      return db.transaction(async (tx) => {
        const rootRunId = await resolveRootRunId(tx, record.runId);
        await lockRootBudgets(tx, [rootRunId]);
        await lockAgentRuns(tx, [record.runId]);
        await lockSandboxSessions(tx, [record.runId]);
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
        if (!(await authoritativeRunIsLive(tx, record.runId, true)))
          return false;
        await tx
          .insert(SandboxRunComputeBudgetTable)
          .values({ runId: record.runId, maxComputeMs: null })
          .onConflictDoNothing();
        await reclaimExpiredCompute(tx, record.runId);
        const [budget] = await tx
          .select()
          .from(SandboxRunComputeBudgetTable)
          .where(eq(SandboxRunComputeBudgetTable.runId, record.runId));
        if (!budget) throw new Error("SANDBOX_COMPUTE_BUDGET_NOT_FOUND");
        const [rootBudget] = await tx
          .select()
          .from(RootRunBudgetTable)
          .where(eq(RootRunBudgetTable.rootRunId, rootRunId))
          .for("update");
        if (!rootBudget) throw new Error("ROOT_RUN_BUDGET_NOT_FOUND");
        if (
          rootBudget.reservedSandboxComputeMs +
            rootBudget.committedSandboxComputeMs +
            record.reservedComputeMs >
          rootBudget.maxSandboxComputeMs
        )
          throw new BudgetExhaustedError("maxComputeMs", {
            ...zeroUsage,
            computeMs: rootBudget.committedSandboxComputeMs,
          });
        const updated = await tx
          .update(SandboxRunComputeBudgetTable)
          .set({
            reservedComputeMs: sql`${SandboxRunComputeBudgetTable.reservedComputeMs} + ${record.reservedComputeMs}`,
            updatedAt: record.reservationExpiresAt,
          })
          .where(and(eq(SandboxRunComputeBudgetTable.runId, record.runId)))
          .returning({ runId: SandboxRunComputeBudgetTable.runId });
        if (updated.length !== 1)
          throw new BudgetExhaustedError("maxComputeMs", zeroUsage);
        await tx
          .update(RootRunBudgetTable)
          .set({
            reservedSandboxComputeMs: sql`${RootRunBudgetTable.reservedSandboxComputeMs} + ${record.reservedComputeMs}`,
            updatedAt: record.reservationExpiresAt,
          })
          .where(eq(RootRunBudgetTable.rootRunId, rootRunId));
        await tx.insert(RootRunBudgetReservationTable).values({
          token: `sandbox:${record.reservationToken}`,
          rootRunId,
          runId: record.runId,
          kind: "sandbox_compute_ms",
          amount: record.reservedComputeMs,
          expiresAt: record.reservationExpiresAt,
        });
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
        await lockRootBudgetForRun(tx, execution.runId);
        await lockAgentRuns(tx, [execution.runId]);
        await lockSandboxSessions(tx, [execution.runId]);
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
        await lockRootBudgetForRun(tx, execution.runId);
        await lockAgentRuns(tx, [execution.runId]);
        await lockSandboxSessions(tx, [execution.runId]);
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
          .returning({
            reservedComputeMs: SandboxExecutionTable.reservedComputeMs,
          });
        if (rows.length !== 1) return false;
        await adjustBudget(tx, execution.runId, -rows[0].reservedComputeMs, 0);
        await settleRootCompute(
          tx,
          execution.runId,
          execution.reservationToken,
          null,
        );
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
        await lockRootBudgetForRun(tx, execution.runId);
        await lockAgentRuns(tx, [execution.runId]);
        await lockSandboxSessions(tx, [execution.runId]);
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
        await settleRootCompute(
          tx,
          execution.runId,
          execution.reservationToken,
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
        await lockAccountingForExecutions(
          tx,
          executions.map((row) => row.runId),
        );
        await tx
          .update(SandboxExecutionTable)
          .set({ status: "cancelled", errorCode, completedAt })
          .where(
            and(
              eq(SandboxExecutionTable.sessionId, sessionId),
              inArray(SandboxExecutionTable.status, ["reserved", "running"]),
            ),
          );
        await releaseCancelledReservations(tx, executions, completedAt);
      });
    },
  };
}

export const pgSandboxRepository = createPgSandboxRepository(pgDb);

type Transaction = Parameters<Parameters<typeof pgDb.transaction>[0]>[0];

async function settleRootCompute(
  tx: Transaction,
  runId: string,
  reservationToken: string,
  committedAmount: number | null,
) {
  const [reservation] = await tx
    .update(RootRunBudgetReservationTable)
    .set({
      state: committedAmount === null ? "released" : "committed",
      committedAmount,
      settledAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(RootRunBudgetReservationTable.token, `sandbox:${reservationToken}`),
        eq(RootRunBudgetReservationTable.runId, runId),
        eq(RootRunBudgetReservationTable.state, "reserved"),
      ),
    )
    .returning();
  if (!reservation) throw new Error("ROOT_RUN_BUDGET_RESERVATION_NOT_FOUND");
  await tx
    .update(RootRunBudgetTable)
    .set({
      reservedSandboxComputeMs: sql`${RootRunBudgetTable.reservedSandboxComputeMs} - ${reservation.amount}`,
      committedSandboxComputeMs: sql`${RootRunBudgetTable.committedSandboxComputeMs} + ${committedAmount ?? 0}`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(RootRunBudgetTable.rootRunId, reservation.rootRunId));
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
    !ACTIVE_AGENT_RUN_STATUSES.includes(run.status as never) ||
    !ACTIVE_AGENT_RUN_STATUSES.includes(root.status as never) ||
    (requireExecutable && run.status !== "running")
  )
    return false;

  const contexts =
    run.id === root.id ? [run.context] : [run.context, root.context];
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

async function reclaimExpiredCompute(tx: Transaction, runId: string) {
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
    .returning({
      reservedComputeMs: SandboxExecutionTable.reservedComputeMs,
      reservationToken: SandboxExecutionTable.reservationToken,
    });
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
        lte(SandboxExecutionTable.settlementDeadlineAt, sql`CURRENT_TIMESTAMP`),
      ),
    )
    .returning({
      reservedComputeMs: SandboxExecutionTable.reservedComputeMs,
      reservationToken: SandboxExecutionTable.reservationToken,
    });
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
  for (const row of released)
    await settleRootCompute(tx, runId, row.reservationToken, null);
  for (const row of charged)
    await settleRootCompute(
      tx,
      runId,
      row.reservationToken,
      row.reservedComputeMs,
    );
}

async function cancelSessions(
  db: typeof pgDb,
  condition: ReturnType<typeof and>,
  completedAt: Date,
) {
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: SandboxSessionTable.id, runId: SandboxSessionTable.runId })
      .from(SandboxSessionTable)
      .where(
        and(
          condition,
          inArray(SandboxSessionTable.status, nonterminalStatuses),
        ),
      );
    await lockAccountingForExecutions(
      tx,
      candidates.map((candidate) => candidate.runId),
    );
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
  tx: Transaction,
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
  await releaseCancelledReservations(tx, executions, completedAt);
}

async function terminalizeLostExecutions(
  tx: Transaction,
  sessionId: string,
  completedAt: Date,
) {
  const executions = await tx
    .select()
    .from(SandboxExecutionTable)
    .where(
      and(
        eq(SandboxExecutionTable.sessionId, sessionId),
        inArray(SandboxExecutionTable.status, ["reserved", "running"]),
      ),
    );
  await tx
    .update(SandboxExecutionTable)
    .set({
      status: "failed",
      errorCode: "SANDBOX_SESSION_LOST",
      durationMs: sql`CASE WHEN ${SandboxExecutionTable.status} = 'running' THEN ${SandboxExecutionTable.reservedComputeMs} ELSE ${SandboxExecutionTable.durationMs} END`,
      observedWallDurationMs: sql`CASE WHEN ${SandboxExecutionTable.status} = 'running' THEN ${SandboxExecutionTable.reservedComputeMs} ELSE ${SandboxExecutionTable.observedWallDurationMs} END`,
      chargedAt: sql`CASE WHEN ${SandboxExecutionTable.status} = 'running' THEN ${completedAt} ELSE ${SandboxExecutionTable.chargedAt} END`,
      completedAt,
    })
    .where(
      and(
        eq(SandboxExecutionTable.sessionId, sessionId),
        inArray(SandboxExecutionTable.status, ["reserved", "running"]),
      ),
    );
  const reservedByRun = new Map<string, number>();
  const chargedByRun = new Map<string, number>();
  for (const execution of executions) {
    const charged = execution.status === "running";
    const target = charged ? chargedByRun : reservedByRun;
    target.set(
      execution.runId,
      (target.get(execution.runId) ?? 0) + execution.reservedComputeMs,
    );
    await settleRootCompute(
      tx,
      execution.runId,
      execution.reservationToken,
      charged ? execution.reservedComputeMs : null,
    );
  }
  for (const runId of new Set([
    ...reservedByRun.keys(),
    ...chargedByRun.keys(),
  ]))
    await adjustBudget(
      tx,
      runId,
      -(reservedByRun.get(runId) ?? 0) - (chargedByRun.get(runId) ?? 0),
      chargedByRun.get(runId) ?? 0,
    );
}

async function lockAccountingForExecutions(tx: Transaction, runIds: string[]) {
  const uniqueRunIds = [...new Set(runIds)];
  const rootRunIds = await Promise.all(
    uniqueRunIds.map((runId) => resolveRootRunId(tx, runId)),
  );
  await lockRootBudgets(tx, rootRunIds);
  await lockAgentRuns(tx, uniqueRunIds);
  await lockSandboxSessions(tx, uniqueRunIds);
}

async function releaseCancelledReservations(
  tx: Transaction,
  executions: Array<typeof SandboxExecutionTable.$inferSelect>,
  completedAt: Date,
) {
  const releasedByRun = new Map<string, number>();
  const chargedByRun = new Map<string, number>();
  for (const execution of executions) {
    const charge =
      execution.status === "running" &&
      execution.settlementDeadlineAt !== null &&
      execution.settlementDeadlineAt <= completedAt;
    if (execution.status !== "reserved" && !charge) continue;
    const target = charge ? chargedByRun : releasedByRun;
    target.set(
      execution.runId,
      (target.get(execution.runId) ?? 0) + execution.reservedComputeMs,
    );
    if (charge)
      await tx
        .update(SandboxExecutionTable)
        .set({
          durationMs: execution.reservedComputeMs,
          observedWallDurationMs: execution.reservedComputeMs,
          chargedAt: completedAt,
        })
        .where(
          and(
            eq(SandboxExecutionTable.id, execution.id),
            isNull(SandboxExecutionTable.chargedAt),
          ),
        );
    await settleRootCompute(
      tx,
      execution.runId,
      execution.reservationToken,
      charge ? execution.reservedComputeMs : null,
    );
  }
  for (const runId of new Set([
    ...releasedByRun.keys(),
    ...chargedByRun.keys(),
  ]))
    await adjustBudget(
      tx,
      runId,
      -(releasedByRun.get(runId) ?? 0) - (chargedByRun.get(runId) ?? 0),
      chargedByRun.get(runId) ?? 0,
    );
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
