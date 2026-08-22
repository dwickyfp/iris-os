import "server-only";

import { randomUUID } from "node:crypto";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { AgentRunRepository } from "lib/ai/runs/agent-run-repository";
import type { RunOutcome } from "lib/ai/runs/types";
import { rootBudgetValues } from "lib/ai/runtime/server-budget-resolver";
import { pgDb as db } from "../db.pg";
import {
  AgentRunCheckpointTable,
  AgentRunContinuationTable,
  AgentRunDispatchTable,
  AgentRunJoinTable,
  AgentRunRemoteCancelTable,
  AgentRunResumeDispatchTable,
  AgentRunTable,
  DelegationRunTable,
  RootRunBudgetReservationTable,
  RootRunBudgetTable,
} from "../schema.pg";

function terminalValues(outcome: RunOutcome) {
  return {
    status: outcome.status,
    result: outcome.status === "succeeded" ? outcome.result : null,
    error: outcome.status === "succeeded" ? null : (outcome.error ?? null),
    errorCode:
      outcome.status === "succeeded" ? null : (outcome.errorCode ?? null),
    completedAt: new Date(),
  };
}

async function observeTerminalChild(
  tx: any,
  run: typeof AgentRunTable.$inferSelect,
) {
  if (!run.parentRunId) return;
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`root-budget:${run.rootRunId}`}, 0))`,
  );
  const settled = await tx
    .update(RootRunBudgetReservationTable)
    .set({
      state: run.status === "cancelled" ? "released" : "committed",
      committedAmount: run.status === "cancelled" ? null : 1,
      settledAt: new Date(),
    })
    .where(
      and(
        eq(RootRunBudgetReservationTable.token, `child:${run.id}`),
        eq(RootRunBudgetReservationTable.state, "reserved"),
      ),
    )
    .returning({ amount: RootRunBudgetReservationTable.amount });
  if (settled[0])
    await tx
      .update(RootRunBudgetTable)
      .set({
        reservedChildren: sql`${RootRunBudgetTable.reservedChildren} - ${settled[0].amount}`,
        committedChildren:
          run.status === "cancelled"
            ? RootRunBudgetTable.committedChildren
            : sql`${RootRunBudgetTable.committedChildren} + ${settled[0].amount}`,
        updatedAt: new Date(),
      })
      .where(eq(RootRunBudgetTable.rootRunId, run.rootRunId));
  await tx
    .update(AgentRunJoinTable)
    .set({
      observation: {
        childRunId: run.id,
        status: run.status,
        result: run.result,
        errorCode: run.errorCode,
        error: run.error?.slice(0, 2_000),
      },
      completedAt: run.completedAt ?? new Date(),
    })
    .where(
      and(
        eq(AgentRunJoinTable.childRunId, run.id),
        isNull(AgentRunJoinTable.completedAt),
      ),
    );
  await tx.execute(sql`
    INSERT INTO agent_run_resume_dispatch
      (parent_run_id, generation, available_at, dispatched_at)
    SELECT checkpoint.parent_run_id, checkpoint.generation,
           CURRENT_TIMESTAMP, NULL
    FROM agent_run_checkpoint checkpoint
    JOIN agent_run parent ON parent.id = checkpoint.parent_run_id
    WHERE checkpoint.parent_run_id = ${run.parentRunId}
      AND checkpoint.completed_at IS NULL
      AND parent.status = 'waiting_external'
      AND parent.cancel_requested_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_run_join pending
        WHERE pending.parent_run_id = checkpoint.parent_run_id
          AND pending.completed_at IS NULL
      )
    ON CONFLICT (parent_run_id) DO UPDATE SET
      generation = EXCLUDED.generation,
      available_at = EXCLUDED.available_at,
      dispatched_at = NULL
  `);
}

export const pgAgentRunRepository: AgentRunRepository = {
  async createRunning(input) {
    const now = new Date();
    const leaseToken = randomUUID();
    let parent: { rootRunId: string } | undefined;
    if (input.parentRunId) {
      const parents = await db
        .select({ rootRunId: AgentRunTable.rootRunId })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, input.parentRunId));
      parent = parents[0];
    }
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(AgentRunTable)
        .values({
          ...input,
          agentId: input.agentId ?? null,
          parentRunId: input.parentRunId ?? null,
          rootRunId: parent?.rootRunId ?? input.id,
          workspaceId: input.workspaceId ?? null,
          taskId: input.taskId ?? null,
          status: "running",
          context: input.context ?? {},
          allowedTools: input.allowedTools ?? [],
          startedAt: now,
          lastHeartbeatAt: now,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + 30_000),
          absoluteDeadlineAt: new Date(
            now.getTime() + (input.timeoutMs ?? 300_000),
          ),
          attempt: 1,
        })
        .onConflictDoNothing()
        .returning();
      if (rows[0] && !input.parentRunId) {
        await tx.insert(RootRunBudgetTable).values({
          rootRunId: input.id,
          ...rootBudgetValues(input.budget ?? {}),
        });
      }
      return rows;
    });
    const created = Array.isArray(inserted) ? inserted[0] : undefined;
    if (created) return created;
    const existing = await this.selectById(input.id, input.userId);
    if (!existing) throw new Error("RUN_CREATE_CONFLICT");
    return existing;
  },

  async createDelegated(input) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${input.parentRunId}))`,
      );
      const [existing] = await tx
        .select({ run: AgentRunTable })
        .from(DelegationRunTable)
        .innerJoin(
          AgentRunTable,
          eq(AgentRunTable.id, DelegationRunTable.childRunId),
        )
        .where(
          and(
            eq(DelegationRunTable.parentRunId, input.parentRunId),
            eq(DelegationRunTable.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing) return existing.run;
      const [{ total, active }] = await tx
        .select({
          total: count(),
          active: sql<number>`count(*) FILTER (WHERE ${AgentRunTable.status} IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'waiting_external'))::int`,
        })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.parentRunId, input.parentRunId));
      if (total >= 8) throw new Error("DELEGATION_CHILD_LIMIT_EXCEEDED");
      if (active >= 8)
        throw new Error("DELEGATION_ACTIVE_CHILD_LIMIT_EXCEEDED");
      const now = new Date();
      const parentRows = await tx
        .select({ absoluteDeadlineAt: AgentRunTable.absoluteDeadlineAt })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, input.parentRunId));
      const parent = Array.isArray(parentRows) ? parentRows[0] : undefined;
      const requestedDeadline = new Date(now.getTime() + input.timeoutMs);
      const absoluteDeadlineAt =
        parent?.absoluteDeadlineAt &&
        parent.absoluteDeadlineAt < requestedDeadline
          ? parent.absoluteDeadlineAt
          : requestedDeadline;
      const [parentRoot] = await tx
        .select({ rootRunId: AgentRunTable.rootRunId })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, input.parentRunId));
      if (!parentRoot) throw new Error("ROOT_RUN_BUDGET_RUN_NOT_FOUND");
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`root-budget:${parentRoot.rootRunId}`}, 0))`,
      );
      const [rootBudget] = await tx
        .select()
        .from(RootRunBudgetTable)
        .where(eq(RootRunBudgetTable.rootRunId, parentRoot.rootRunId))
        .for("update");
      if (!rootBudget) throw new Error("ROOT_RUN_BUDGET_NOT_FOUND");
      if (input.depth > rootBudget.maxDelegationDepth)
        throw new Error("BUDGET_EXHAUSTED");
      if (
        rootBudget.committedDelegations + rootBudget.reservedDelegations + 1 >
          rootBudget.maxDelegations ||
        rootBudget.reservedChildren + 1 > rootBudget.maxParallelChildren
      )
        throw new Error("BUDGET_EXHAUSTED");
      await tx
        .update(RootRunBudgetTable)
        .set({
          committedDelegations: sql`${RootRunBudgetTable.committedDelegations} + 1`,
          reservedChildren: sql`${RootRunBudgetTable.reservedChildren} + 1`,
          updatedAt: now,
        })
        .where(eq(RootRunBudgetTable.rootRunId, parentRoot.rootRunId));
      await tx.insert(RootRunBudgetReservationTable).values([
        {
          token: `delegation:${input.id}`,
          rootRunId: parentRoot.rootRunId,
          runId: input.parentRunId,
          kind: "delegations",
          amount: 1,
          state: "committed",
          committedAmount: 1,
          expiresAt: absoluteDeadlineAt,
          settledAt: now,
        },
        {
          token: `child:${input.id}`,
          rootRunId: parentRoot.rootRunId,
          runId: input.parentRunId,
          kind: "children",
          amount: 1,
          expiresAt: absoluteDeadlineAt,
        },
      ]);
      const inserted = await tx
        .insert(AgentRunTable)
        .values({
          id: input.id,
          userId: input.userId,
          agentId: input.agentId ?? null,
          parentRunId: input.parentRunId,
          workspaceId: input.workspaceId ?? null,
          taskId: input.taskId ?? null,
          status: "queued",
          context: input.context,
          allowedTools: input.allowedTools,
          timeoutMs: input.timeoutMs,
          depth: input.depth,
          tokenBudget: input.tokenBudget,
          absoluteDeadlineAt,
          rootRunId: parentRoot.rootRunId,
        })
        .returning();
      const run = Array.isArray(inserted) ? inserted[0] : undefined;
      if (!run) throw new Error("DELEGATED_RUN_CREATE_FAILED");
      await tx.insert(DelegationRunTable).values({
        id: input.delegationId,
        parentRunId: input.parentRunId,
        childRunId: input.id,
        userId: input.userId,
        objective: input.objective,
        idempotencyKey: input.idempotencyKey,
        targetKind:
          input.target.kind === "remote" ? "remote_agent" : "local_agent",
        remoteAgentId:
          input.target.kind === "remote" ? input.target.connectionId : null,
        remoteProtocol: input.target.kind === "remote" ? "a2a" : null,
      });
      await tx.insert(AgentRunJoinTable).values({
        parentRunId: input.parentRunId,
        checkpointGeneration: sql`COALESCE((
          SELECT ${AgentRunCheckpointTable.generation} + 1
          FROM ${AgentRunCheckpointTable}
          WHERE ${AgentRunCheckpointTable.parentRunId} = ${input.parentRunId}
        ), 1)`,
        toolCallId: input.toolCallId,
        childRunId: input.id,
      });
      await tx.insert(AgentRunDispatchTable).values({ runId: input.id });
      return run;
    });
  },

  async selectById(id, userId) {
    const [run] = await db
      .select()
      .from(AgentRunTable)
      .where(
        userId
          ? and(eq(AgentRunTable.id, id), eq(AgentRunTable.userId, userId))
          : eq(AgentRunTable.id, id),
      );
    return run ?? null;
  },

  async claimQueued(id, leaseMs) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const leaseToken = randomUUID();
      const [candidate] = await tx
        .select({
          parentRunId: AgentRunTable.parentRunId,
          status: AgentRunTable.status,
          leaseToken: AgentRunTable.leaseToken,
          leaseExpiresAt: AgentRunTable.leaseExpiresAt,
          cancelRequestedAt: AgentRunTable.cancelRequestedAt,
          absoluteDeadlineAt: AgentRunTable.absoluteDeadlineAt,
        })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, id));
      if (
        ["queued", "waiting_external"].includes(candidate?.status ?? "") &&
        candidate.absoluteDeadlineAt &&
        candidate.absoluteDeadlineAt <= now
      ) {
        const values = {
          status: "timed_out" as const,
          completedAt: now,
          errorCode: "TIMED_OUT",
          error: "Run deadline exceeded before execution",
        };
        const [timedOut] = await tx
          .update(AgentRunTable)
          .set(values)
          .where(
            and(
              eq(AgentRunTable.id, id),
              inArray(AgentRunTable.status, ["queued", "waiting_external"]),
            ),
          )
          .returning();
        await tx
          .update(DelegationRunTable)
          .set(values)
          .where(eq(DelegationRunTable.childRunId, id));
        await tx
          .delete(AgentRunContinuationTable)
          .where(
            and(
              eq(AgentRunContinuationTable.runId, id),
              eq(AgentRunContinuationTable.kind, "credential"),
            ),
          );
        if (timedOut) await observeTerminalChild(tx, timedOut);
        return null;
      }
      if (candidate?.parentRunId) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${candidate.parentRunId}))`,
        );
        const [{ active }] = await tx
          .select({ active: count() })
          .from(AgentRunTable)
          .where(
            and(
              eq(AgentRunTable.parentRunId, candidate.parentRunId),
              eq(AgentRunTable.status, "running"),
            ),
          );
        if (active >= 3) return null;
      }
      if (
        !candidate ||
        candidate.cancelRequestedAt ||
        (candidate.absoluteDeadlineAt && candidate.absoluteDeadlineAt <= now) ||
        !(
          candidate.status === "queued" ||
          candidate.status === "waiting_external" ||
          (candidate.status === "running" &&
            candidate.leaseExpiresAt &&
            candidate.leaseExpiresAt <= now)
        )
      )
        return null;
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          status: "running",
          startedAt: sql`COALESCE(${AgentRunTable.startedAt}, ${now})`,
          lastHeartbeatAt: now,
          leaseToken,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempt: sql`${AgentRunTable.attempt} + 1`,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, candidate.status),
            candidate.status === "running"
              ? eq(AgentRunTable.leaseToken, candidate.leaseToken!)
              : isNull(AgentRunTable.leaseToken),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .update(DelegationRunTable)
        .set({ status: "running", startedAt: run.startedAt ?? now })
        .where(
          and(
            eq(DelegationRunTable.childRunId, id),
            inArray(DelegationRunTable.status, ["queued", "waiting_external"]),
          ),
        );
      return { run, token: leaseToken };
    });
  },

  async heartbeat(id, leaseToken, leaseMs) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [current] = await tx
        .select({
          status: AgentRunTable.status,
          leaseToken: AgentRunTable.leaseToken,
          leaseExpiresAt: AgentRunTable.leaseExpiresAt,
          cancelRequestedAt: AgentRunTable.cancelRequestedAt,
          absoluteDeadlineAt: AgentRunTable.absoluteDeadlineAt,
        })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, id))
        .for("update");
      if (
        !current ||
        current.status !== "running" ||
        current.leaseToken !== leaseToken ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= now
      )
        return "lease_lost";
      if (current.cancelRequestedAt) return "cancelled";
      if (current.absoluteDeadlineAt && current.absoluteDeadlineAt <= now)
        return "timed_out";
      const [checkpointClaim] = await tx
        .select({
          claimToken: AgentRunCheckpointTable.claimToken,
          claimExpiresAt: AgentRunCheckpointTable.claimExpiresAt,
          completedAt: AgentRunCheckpointTable.completedAt,
        })
        .from(AgentRunCheckpointTable)
        .where(eq(AgentRunCheckpointTable.parentRunId, id))
        .for("update");
      if (
        checkpointClaim?.claimToken !== null &&
        checkpointClaim?.claimToken !== undefined &&
        (checkpointClaim.claimToken !== leaseToken ||
          !checkpointClaim.claimExpiresAt ||
          checkpointClaim.claimExpiresAt <= now ||
          checkpointClaim.completedAt)
      )
        return "lease_lost";
      const expiresAt = new Date(now.getTime() + leaseMs);
      if (checkpointClaim?.claimToken === leaseToken) {
        const [checkpoint] = await tx
          .update(AgentRunCheckpointTable)
          .set({ claimExpiresAt: expiresAt, updatedAt: now })
          .where(
            and(
              eq(AgentRunCheckpointTable.parentRunId, id),
              eq(AgentRunCheckpointTable.claimToken, leaseToken),
              isNull(AgentRunCheckpointTable.completedAt),
            ),
          )
          .returning({ parentRunId: AgentRunCheckpointTable.parentRunId });
        if (!checkpoint) return "lease_lost";
      }
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          lastHeartbeatAt: now,
          leaseExpiresAt: expiresAt,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
            isNull(AgentRunTable.cancelRequestedAt),
          ),
        )
        .returning({ id: AgentRunTable.id });
      if (!run) throw new Error("HEARTBEAT_RUN_RENEWAL_FAILED");
      return "active";
    });
  },

  async finishRunning(id, leaseToken, outcome) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [leased] = await tx
        .select({
          status: AgentRunTable.status,
          leaseToken: AgentRunTable.leaseToken,
          leaseExpiresAt: AgentRunTable.leaseExpiresAt,
          cancelRequestedAt: AgentRunTable.cancelRequestedAt,
          absoluteDeadlineAt: AgentRunTable.absoluteDeadlineAt,
        })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, id))
        .for("update");
      if (
        leased?.status !== "running" ||
        leased.leaseToken !== leaseToken ||
        !leased.leaseExpiresAt ||
        leased.leaseExpiresAt <= now
      )
        return null;
      const classifiedOutcome: RunOutcome = leased.cancelRequestedAt
        ? {
            status: "cancelled",
            error: "Run was cancelled",
            errorCode: "CANCELLED",
          }
        : leased.absoluteDeadlineAt && leased.absoluteDeadlineAt <= now
          ? {
              status: "timed_out",
              error: "Run deadline exceeded",
              errorCode: "TIMED_OUT",
            }
          : outcome;
      const values = terminalValues(classifiedOutcome);
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          ...values,
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
          ),
        )
        .returning();
      if (!run) return null;
      const classifiedValues = {
        status: run.status,
        result: run.result,
        error: run.error,
        errorCode: run.errorCode,
        completedAt: run.completedAt,
      };
      await tx
        .update(DelegationRunTable)
        .set(classifiedValues)
        .where(
          and(
            eq(DelegationRunTable.childRunId, id),
            eq(DelegationRunTable.status, "running"),
          ),
        );
      await tx
        .delete(AgentRunContinuationTable)
        .where(
          and(
            eq(AgentRunContinuationTable.runId, id),
            eq(AgentRunContinuationTable.kind, "credential"),
          ),
        );
      await observeTerminalChild(tx, run);
      return run;
    });
  },

  async wait(id, status, reason, leaseToken) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          status,
          waitingReason: reason,
          lastHeartbeatAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
            sql`${AgentRunTable.leaseExpiresAt} > ${now}`,
            isNull(AgentRunTable.cancelRequestedAt),
            or(
              isNull(AgentRunTable.absoluteDeadlineAt),
              sql`${AgentRunTable.absoluteDeadlineAt} > ${now}`,
            ),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .update(DelegationRunTable)
        .set({ status })
        .where(eq(DelegationRunTable.childRunId, id));
      return run;
    });
  },

  async resume(input) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const expectedStatus =
        input.continuation.kind === "input"
          ? "waiting_input"
          : "waiting_approval";
      const [owned] = await tx
        .select({ id: AgentRunTable.id })
        .from(AgentRunTable)
        .where(
          and(
            eq(AgentRunTable.id, input.runId),
            eq(AgentRunTable.userId, input.userId),
            eq(AgentRunTable.status, expectedStatus),
            sql`${AgentRunTable.cancelRequestedAt} IS NULL`,
            or(
              isNull(AgentRunTable.absoluteDeadlineAt),
              sql`${AgentRunTable.absoluteDeadlineAt} > ${now}`,
            ),
          ),
        );
      if (!owned) return null;
      await tx
        .insert(AgentRunContinuationTable)
        .values({
          runId: input.runId,
          kind: input.continuation.kind,
          submissionId: randomUUID(),
          messageId: randomUUID(),
          payload:
            input.continuation.kind === "input"
              ? input.continuation.payload
              : null,
          encryptedCredential:
            input.continuation.kind === "credential"
              ? input.continuation.encryptedCredential
              : null,
        })
        .onConflictDoUpdate({
          target: [
            AgentRunContinuationTable.runId,
            AgentRunContinuationTable.kind,
          ],
          set: {
            submissionId: randomUUID(),
            messageId: randomUUID(),
            payload:
              input.continuation.kind === "input"
                ? input.continuation.payload
                : null,
            encryptedCredential:
              input.continuation.kind === "credential"
                ? input.continuation.encryptedCredential
                : null,
            createdAt: now,
            consumedAt: null,
          },
        });
      const [run] = await tx
        .update(AgentRunTable)
        .set({ status: "queued", waitingReason: null })
        .where(
          and(
            eq(AgentRunTable.id, input.runId),
            eq(AgentRunTable.userId, input.userId),
            eq(AgentRunTable.status, expectedStatus),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .update(DelegationRunTable)
        .set({ status: "queued" })
        .where(eq(DelegationRunTable.childRunId, input.runId));
      await tx
        .insert(AgentRunDispatchTable)
        .values({ runId: input.runId })
        .onConflictDoUpdate({
          target: AgentRunDispatchTable.runId,
          set: { availableAt: now, dispatchedAt: null },
        });
      return run;
    });
  },

  async consumeContinuation(id, leaseToken) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [row] = await tx
        .select({ continuation: AgentRunContinuationTable })
        .from(AgentRunContinuationTable)
        .innerJoin(
          AgentRunTable,
          eq(AgentRunTable.id, AgentRunContinuationTable.runId),
        )
        .where(
          and(
            eq(AgentRunContinuationTable.runId, id),
            isNull(AgentRunContinuationTable.consumedAt),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
            sql`${AgentRunTable.leaseExpiresAt} > ${now}`,
            isNull(AgentRunTable.cancelRequestedAt),
            or(
              isNull(AgentRunTable.absoluteDeadlineAt),
              sql`${AgentRunTable.absoluteDeadlineAt} > ${now}`,
            ),
          ),
        );
      if (!row) return null;
      return row.continuation.kind === "input"
        ? {
            kind: "input" as const,
            submissionId: row.continuation.submissionId,
            messageId: row.continuation.messageId,
            payload: row.continuation.payload ?? {},
          }
        : {
            kind: "credential" as const,
            submissionId: row.continuation.submissionId,
            messageId: row.continuation.messageId,
            encryptedCredential: row.continuation.encryptedCredential!,
          };
    });
  },

  async consumeContinuationMessage(id, leaseToken, submissionId) {
    const now = new Date();
    const [consumed] = await db
      .update(AgentRunContinuationTable)
      .set({ consumedAt: now })
      .where(
        and(
          eq(AgentRunContinuationTable.runId, id),
          eq(AgentRunContinuationTable.submissionId, submissionId),
          isNull(AgentRunContinuationTable.consumedAt),
          sql`EXISTS (
            SELECT 1 FROM ${AgentRunTable}
            WHERE ${AgentRunTable.id} = ${id}
              AND ${AgentRunTable.status} = 'running'
              AND ${AgentRunTable.leaseToken} = ${leaseToken}
              AND ${AgentRunTable.leaseExpiresAt} > ${now}
          )`,
        ),
      )
      .returning({ runId: AgentRunContinuationTable.runId });
    return Boolean(consumed);
  },

  async selectTransientCredential(id, leaseToken) {
    const now = new Date();
    const [row] = await db
      .select({
        encryptedCredential: AgentRunContinuationTable.encryptedCredential,
      })
      .from(AgentRunContinuationTable)
      .innerJoin(
        AgentRunTable,
        eq(AgentRunTable.id, AgentRunContinuationTable.runId),
      )
      .where(
        and(
          eq(AgentRunContinuationTable.runId, id),
          eq(AgentRunContinuationTable.kind, "credential"),
          eq(AgentRunTable.status, "running"),
          eq(AgentRunTable.leaseToken, leaseToken),
          sql`${AgentRunTable.leaseExpiresAt} > ${now}`,
        ),
      );
    return row?.encryptedCredential ?? null;
  },

  async prepareRemoteSubmission(id, leaseToken) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [leased] = await tx
        .select({ id: AgentRunTable.id })
        .from(AgentRunTable)
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
            sql`${AgentRunTable.leaseExpiresAt} > ${now}`,
            isNull(AgentRunTable.cancelRequestedAt),
            or(
              isNull(AgentRunTable.absoluteDeadlineAt),
              sql`${AgentRunTable.absoluteDeadlineAt} > ${now}`,
            ),
          ),
        )
        .for("update");
      if (!leased) return null;
      const [row] = await tx
        .select({ run: AgentRunTable, delegation: DelegationRunTable })
        .from(AgentRunTable)
        .innerJoin(
          DelegationRunTable,
          eq(DelegationRunTable.childRunId, AgentRunTable.id),
        )
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
            sql`${AgentRunTable.leaseExpiresAt} > ${now}`,
            isNull(AgentRunTable.cancelRequestedAt),
            or(
              isNull(AgentRunTable.absoluteDeadlineAt),
              sql`${AgentRunTable.absoluteDeadlineAt} > ${now}`,
            ),
            eq(DelegationRunTable.targetKind, "remote_agent"),
          ),
        );
      if (!row) return null;
      let submissionId = row.delegation.submissionId;
      let messageId = row.delegation.messageId;
      let payload = row.delegation.submissionPayload;
      if (!submissionId || !messageId || !payload) {
        submissionId = randomUUID();
        messageId = randomUUID();
        payload = {
          message: {
            role: "user",
            messageId,
            parts: [
              {
                kind: "text",
                text: String(
                  row.run.context.objective ?? "Complete the delegated work",
                ),
              },
            ],
          },
          metadata: {
            runId: row.run.id,
            parentRunId: row.run.parentRunId,
            submissionId,
          },
        };
        const [stored] = await tx
          .update(DelegationRunTable)
          .set({
            submissionId,
            messageId,
            submissionPayload: payload,
            submissionStartedAt: now,
          })
          .where(eq(DelegationRunTable.childRunId, id))
          .returning({ id: DelegationRunTable.id });
        if (!stored) return null;
      }
      return {
        submissionId,
        messageId,
        payload,
        remoteTaskId: row.delegation.remoteTaskId,
        remoteContextId: row.delegation.remoteContextId,
      };
    });
  },

  async recordRemoteTask(id, leaseToken, task) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [leased] = await tx
        .select({ id: AgentRunTable.id })
        .from(AgentRunTable)
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
            sql`${AgentRunTable.leaseExpiresAt} > ${now}`,
            isNull(AgentRunTable.cancelRequestedAt),
            or(
              isNull(AgentRunTable.absoluteDeadlineAt),
              sql`${AgentRunTable.absoluteDeadlineAt} > ${now}`,
            ),
          ),
        )
        .for("update");
      if (!leased) return false;
      const [updated] = await tx
        .update(DelegationRunTable)
        .set({
          remoteTaskId: task.id,
          remoteContextId: task.contextId ?? null,
          remoteStatus: task.state,
          remoteMetadata: task.metadata ?? null,
        })
        .where(eq(DelegationRunTable.childRunId, id))
        .returning({ id: DelegationRunTable.id });
      if (!updated) return false;
      return true;
    });
  },

  async deferRemoteTask(id, leaseToken, reason, task, availableAt) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          status: "waiting_external",
          waitingReason: reason,
          lastHeartbeatAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
            sql`${AgentRunTable.leaseExpiresAt} > ${now}`,
            isNull(AgentRunTable.cancelRequestedAt),
            or(
              isNull(AgentRunTable.absoluteDeadlineAt),
              sql`${AgentRunTable.absoluteDeadlineAt} > ${now}`,
            ),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .update(DelegationRunTable)
        .set({
          status: "waiting_external",
          remoteTaskId: task.id,
          remoteContextId: task.contextId ?? null,
          remoteStatus: task.state,
          remoteMetadata: task.metadata ?? null,
        })
        .where(eq(DelegationRunTable.childRunId, id));
      await tx
        .insert(AgentRunDispatchTable)
        .values({ runId: id, availableAt })
        .onConflictDoUpdate({
          target: AgentRunDispatchTable.runId,
          set: { availableAt, dispatchedAt: null },
        });
      return run;
    });
  },

  async cancelQueued(id, details) {
    return db.transaction(async (tx) => {
      const completedAt = new Date();
      const values = {
        status: "cancelled" as const,
        cancelRequestedAt: completedAt,
        completedAt,
        error: details?.error ?? null,
        errorCode: details?.errorCode ?? null,
      };
      const [run] = await tx
        .update(AgentRunTable)
        .set(values)
        .where(
          and(
            eq(AgentRunTable.id, id),
            inArray(AgentRunTable.status, ["queued", "waiting_external"]),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .update(DelegationRunTable)
        .set(values)
        .where(
          and(
            eq(DelegationRunTable.childRunId, id),
            inArray(DelegationRunTable.status, ["queued", "waiting_external"]),
          ),
        );
      await tx
        .delete(AgentRunContinuationTable)
        .where(
          and(
            eq(AgentRunContinuationTable.runId, id),
            eq(AgentRunContinuationTable.kind, "credential"),
          ),
        );
      await observeTerminalChild(tx, run);
      return run;
    });
  },

  async requestCancellationTree(id, userId) {
    return db.transaction(async (tx) => {
      const [owned] = await tx
        .select()
        .from(AgentRunTable)
        .where(and(eq(AgentRunTable.id, id), eq(AgentRunTable.userId, userId)));
      if (
        !owned ||
        ![
          "queued",
          "running",
          "waiting_approval",
          "waiting_input",
          "waiting_external",
        ].includes(owned.status)
      )
        return null;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`root-budget:${owned.rootRunId}`}, 0))`,
      );
      await tx.execute(sql`
        WITH RECURSIVE run_tree AS (
          SELECT id FROM agent_run WHERE id = ${id} AND user_id = ${userId}
          UNION ALL
          SELECT child.id FROM agent_run child
          JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.user_id = ${userId}
        )
        INSERT INTO agent_run_remote_cancel (run_id)
        SELECT run.id
        FROM agent_run run
        JOIN delegation_run delegation ON delegation.child_run_id = run.id
        WHERE run.id IN (SELECT id FROM run_tree)
          AND run.status IN ('waiting_external', 'running')
          AND delegation.target_kind = 'remote_agent'
          AND delegation.remote_task_id IS NOT NULL
        ON CONFLICT (run_id) DO UPDATE SET
          available_at = CURRENT_TIMESTAMP,
          dispatched_at = NULL,
          last_error = NULL,
          remote_outcome = NULL,
          completed_at = NULL
      `);
      await tx.execute(sql`
        WITH RECURSIVE run_tree AS (
          SELECT id FROM agent_run WHERE id = ${id} AND user_id = ${userId}
          UNION ALL
          SELECT child.id FROM agent_run child
          JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.user_id = ${userId}
        )
        UPDATE agent_run
        SET cancel_requested_at = CURRENT_TIMESTAMP,
            status = CASE WHEN status IN ('queued', 'waiting_approval', 'waiting_input', 'waiting_external')
              AND NOT EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = agent_run.id AND cancel.completed_at IS NULL)
              THEN 'cancelled' ELSE status END,
            completed_at = CASE WHEN status IN ('queued', 'waiting_approval', 'waiting_input', 'waiting_external')
              AND NOT EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = agent_run.id AND cancel.completed_at IS NULL)
              THEN CURRENT_TIMESTAMP ELSE completed_at END,
            error_code = CASE WHEN status IN ('queued', 'waiting_approval', 'waiting_input', 'waiting_external')
              AND NOT EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = agent_run.id AND cancel.completed_at IS NULL)
              THEN 'CANCELLED' ELSE error_code END,
            error = CASE WHEN status IN ('queued', 'waiting_approval', 'waiting_input', 'waiting_external')
              AND NOT EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = agent_run.id AND cancel.completed_at IS NULL)
              THEN 'Run was cancelled' ELSE error END
        WHERE id IN (SELECT id FROM run_tree)
          AND status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'waiting_external')
      `);
      await tx.execute(sql`
        WITH RECURSIVE run_tree AS (
          SELECT id FROM agent_run WHERE id = ${id} AND user_id = ${userId}
          UNION ALL
          SELECT child.id FROM agent_run child
          JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.user_id = ${userId}
        ), settled AS (
          UPDATE root_run_budget_reservation reservation
          SET state = 'released', committed_amount = NULL,
              settled_at = CURRENT_TIMESTAMP
          FROM agent_run child
          WHERE child.id IN (SELECT id FROM run_tree)
            AND child.status = 'cancelled'
            AND reservation.token = 'child:' || child.id::text
            AND reservation.root_run_id = ${owned.rootRunId}
            AND reservation.kind = 'children'
            AND reservation.state = 'reserved'
          RETURNING reservation.amount
        )
        UPDATE root_run_budget
        SET reserved_children = reserved_children -
              COALESCE((SELECT SUM(amount) FROM settled), 0),
            updated_at = CURRENT_TIMESTAMP
        WHERE root_run_id = ${owned.rootRunId}
          AND EXISTS (SELECT 1 FROM settled)
      `);
      await tx.execute(sql`
        WITH RECURSIVE run_tree AS (
          SELECT id FROM agent_run WHERE id = ${id} AND user_id = ${userId}
          UNION ALL
          SELECT child.id FROM agent_run child
          JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.user_id = ${userId}
        )
        UPDATE delegation_run
        SET status = CASE WHEN EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = delegation_run.child_run_id AND cancel.completed_at IS NULL) THEN status ELSE 'cancelled' END,
            completed_at = CASE WHEN EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = delegation_run.child_run_id AND cancel.completed_at IS NULL) THEN completed_at ELSE CURRENT_TIMESTAMP END,
            error_code = CASE WHEN EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = delegation_run.child_run_id AND cancel.completed_at IS NULL) THEN error_code ELSE 'CANCELLED' END,
            error = CASE WHEN EXISTS (SELECT 1 FROM agent_run_remote_cancel cancel WHERE cancel.run_id = delegation_run.child_run_id AND cancel.completed_at IS NULL) THEN error ELSE 'Run was cancelled' END
        WHERE child_run_id IN (SELECT id FROM run_tree)
          AND user_id = ${userId}
          AND status IN ('queued', 'waiting_approval', 'waiting_input', 'waiting_external')
      `);
      await tx.execute(sql`
        WITH RECURSIVE run_tree AS (
          SELECT id FROM agent_run WHERE id = ${id} AND user_id = ${userId}
          UNION ALL
          SELECT child.id FROM agent_run child
          JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.user_id = ${userId}
        )
        UPDATE agent_run_join join_row
        SET observation = json_build_object(
              'childRunId', child.id,
              'status', child.status,
              'result', child.result,
              'errorCode', child.error_code,
              'error', child.error
            ),
            completed_at = child.completed_at
        FROM agent_run child
        WHERE join_row.child_run_id = child.id
          AND child.id IN (SELECT id FROM run_tree)
          AND child.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
          AND join_row.completed_at IS NULL
      `);
      await tx.execute(sql`
        INSERT INTO agent_run_resume_dispatch
          (parent_run_id, generation, available_at, dispatched_at)
        SELECT checkpoint.parent_run_id, checkpoint.generation,
               CURRENT_TIMESTAMP, NULL
        FROM agent_run_checkpoint checkpoint
        JOIN agent_run parent ON parent.id = checkpoint.parent_run_id
        WHERE checkpoint.completed_at IS NULL
          AND parent.status = 'waiting_external'
          AND parent.cancel_requested_at IS NULL
          AND checkpoint.parent_run_id IN (
            SELECT DISTINCT parent_run_id FROM agent_run_join
            WHERE child_run_id IN (
              WITH RECURSIVE run_tree AS (
                SELECT id FROM agent_run WHERE id = ${id} AND user_id = ${userId}
                UNION ALL
                SELECT child.id FROM agent_run child
                JOIN run_tree parent ON child.parent_run_id = parent.id
                WHERE child.user_id = ${userId}
              ) SELECT id FROM run_tree
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_run_join pending
            WHERE pending.parent_run_id = checkpoint.parent_run_id
              AND pending.completed_at IS NULL
          )
        ON CONFLICT (parent_run_id) DO UPDATE SET
          generation = EXCLUDED.generation,
          available_at = EXCLUDED.available_at,
          dispatched_at = NULL
      `);
      await tx.execute(sql`
        WITH RECURSIVE run_tree AS (
          SELECT id FROM agent_run WHERE id = ${id} AND user_id = ${userId}
          UNION ALL
          SELECT child.id FROM agent_run child
          JOIN run_tree parent ON child.parent_run_id = parent.id
          WHERE child.user_id = ${userId}
        )
        DELETE FROM agent_run_continuation continuation
        USING agent_run run
        WHERE continuation.run_id = run.id
          AND continuation.kind = 'credential'
          AND run.status IN ('succeeded', 'failed', 'cancelled', 'timed_out')
          AND run.id IN (SELECT id FROM run_tree)
      `);
      const [updated] = await tx
        .select()
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, id));
      return updated ?? null;
    });
  },

  async prepareRemoteCancellation(id) {
    const [row] = await db
      .select({
        userId: AgentRunTable.userId,
        remoteAgentId: DelegationRunTable.remoteAgentId,
        remoteTaskId: DelegationRunTable.remoteTaskId,
        encryptedCredential: AgentRunContinuationTable.encryptedCredential,
      })
      .from(AgentRunRemoteCancelTable)
      .innerJoin(
        AgentRunTable,
        eq(AgentRunTable.id, AgentRunRemoteCancelTable.runId),
      )
      .innerJoin(
        DelegationRunTable,
        eq(DelegationRunTable.childRunId, AgentRunRemoteCancelTable.runId),
      )
      .leftJoin(
        AgentRunContinuationTable,
        and(
          eq(AgentRunContinuationTable.runId, AgentRunRemoteCancelTable.runId),
          eq(AgentRunContinuationTable.kind, "credential"),
        ),
      )
      .where(
        and(
          eq(AgentRunRemoteCancelTable.runId, id),
          isNull(AgentRunRemoteCancelTable.completedAt),
          isNotNull(AgentRunTable.cancelRequestedAt),
        ),
      );
    if (!row?.remoteAgentId || !row.remoteTaskId) return null;
    return {
      userId: row.userId,
      remoteAgentId: row.remoteAgentId,
      remoteTaskId: row.remoteTaskId,
      encryptedCredential: row.encryptedCredential,
    };
  },

  async recordRemoteCancellation(id, outcome) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const terminal =
        outcome.ok &&
        ["cancelled", "completed", "failed", "rejected"].includes(
          outcome.task.state,
        );
      await tx
        .update(AgentRunRemoteCancelTable)
        .set({
          dispatchedAt: null,
          availableAt: terminal ? now : outcome.retryAt,
          lastError: outcome.ok ? null : outcome.error,
          remoteOutcome: outcome.ok ? outcome.task : null,
          completedAt: terminal ? now : null,
        })
        .where(eq(AgentRunRemoteCancelTable.runId, id));
      if (!terminal) return null;
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          status: "cancelled",
          completedAt: now,
          errorCode: "CANCELLED",
          error: "Run was cancelled after remote cancellation reconciliation",
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            isNotNull(AgentRunTable.cancelRequestedAt),
            inArray(AgentRunTable.status, ["waiting_external", "running"]),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .update(DelegationRunTable)
        .set({
          status: "cancelled",
          remoteStatus: outcome.task.state,
          completedAt: now,
          errorCode: "CANCELLED",
          error: "Run was cancelled after remote cancellation reconciliation",
        })
        .where(eq(DelegationRunTable.childRunId, id));
      await tx
        .delete(AgentRunContinuationTable)
        .where(
          and(
            eq(AgentRunContinuationTable.runId, id),
            eq(AgentRunContinuationTable.kind, "credential"),
          ),
        );
      await observeTerminalChild(tx, run);
      return run;
    });
  },

  async isCancellationRequested(ids) {
    if (!ids.length) return false;
    const [run] = await db
      .select({ id: AgentRunTable.id })
      .from(AgentRunTable)
      .where(
        and(
          inArray(AgentRunTable.id, [...ids]),
          isNotNull(AgentRunTable.cancelRequestedAt),
        ),
      )
      .limit(1);
    return Boolean(run);
  },

  async countRunningChildren(parentRunId) {
    const [{ total }] = await db
      .select({ total: count() })
      .from(AgentRunTable)
      .where(
        and(
          eq(AgentRunTable.parentRunId, parentRunId),
          eq(AgentRunTable.status, "running"),
        ),
      );
    return total;
  },

  async listStaleDelegatedRunIds(before, limit) {
    const rows = await db
      .select({ id: AgentRunTable.id })
      .from(AgentRunTable)
      .innerJoin(
        DelegationRunTable,
        eq(DelegationRunTable.childRunId, AgentRunTable.id),
      )
      .where(
        and(
          or(
            and(
              eq(AgentRunTable.status, "queued"),
              lt(AgentRunTable.createdAt, before),
            ),
            and(
              eq(AgentRunTable.status, "running"),
              lte(AgentRunTable.leaseExpiresAt, new Date()),
            ),
          ),
        ),
      )
      .limit(limit);
    return rows.map((row) => row.id);
  },

  async listPendingDispatchRunIds(limit) {
    const rows = await db
      .select({ runId: AgentRunDispatchTable.runId })
      .from(AgentRunDispatchTable)
      .where(
        and(
          isNull(AgentRunDispatchTable.dispatchedAt),
          lte(AgentRunDispatchTable.availableAt, new Date()),
        ),
      )
      .limit(limit);
    return rows.map((row) => row.runId);
  },

  async markDispatched(id) {
    await db
      .update(AgentRunDispatchTable)
      .set({
        dispatchedAt: new Date(),
        attempts: sql`${AgentRunDispatchTable.attempts} + 1`,
      })
      .where(eq(AgentRunDispatchTable.runId, id));
  },

  async listPendingRemoteCancellationRunIds(limit) {
    const rows = await db
      .select({ runId: AgentRunRemoteCancelTable.runId })
      .from(AgentRunRemoteCancelTable)
      .where(
        and(
          isNull(AgentRunRemoteCancelTable.completedAt),
          or(
            isNull(AgentRunRemoteCancelTable.dispatchedAt),
            lte(
              AgentRunRemoteCancelTable.dispatchedAt,
              new Date(Date.now() - 60_000),
            ),
          ),
          lte(AgentRunRemoteCancelTable.availableAt, new Date()),
        ),
      )
      .limit(limit);
    return rows.map((row) => row.runId);
  },

  async markRemoteCancellationDispatched(id) {
    await db
      .update(AgentRunRemoteCancelTable)
      .set({
        dispatchedAt: new Date(),
        attempts: sql`${AgentRunRemoteCancelTable.attempts} + 1`,
      })
      .where(eq(AgentRunRemoteCancelTable.runId, id));
  },

  async suspendParent(id, leaseToken, checkpoint) {
    return db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
      const [leased] = await tx
        .select({
          status: AgentRunTable.status,
          leaseToken: AgentRunTable.leaseToken,
          leaseExpiresAt: AgentRunTable.leaseExpiresAt,
          cancelRequestedAt: AgentRunTable.cancelRequestedAt,
          absoluteDeadlineAt: AgentRunTable.absoluteDeadlineAt,
        })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, id))
        .for("update");
      if (
        leased?.status !== "running" ||
        leased.leaseToken !== leaseToken ||
        !leased.leaseExpiresAt ||
        leased.leaseExpiresAt <= now
      )
        return null;
      const [currentCheckpoint] = await tx
        .select({
          generation: AgentRunCheckpointTable.generation,
          claimToken: AgentRunCheckpointTable.claimToken,
          claimExpiresAt: AgentRunCheckpointTable.claimExpiresAt,
          completedAt: AgentRunCheckpointTable.completedAt,
        })
        .from(AgentRunCheckpointTable)
        .where(eq(AgentRunCheckpointTable.parentRunId, id))
        .for("update");
      if (
        currentCheckpoint?.claimToken &&
        (currentCheckpoint.claimToken !== leaseToken ||
          !currentCheckpoint.claimExpiresAt ||
          currentCheckpoint.claimExpiresAt <= now ||
          currentCheckpoint.completedAt)
      )
        return null;
      const classifiedOutcome: RunOutcome | undefined = leased.cancelRequestedAt
        ? {
            status: "cancelled",
            error: "Run was cancelled",
            errorCode: "CANCELLED",
          }
        : leased.absoluteDeadlineAt && leased.absoluteDeadlineAt <= now
          ? {
              status: "timed_out",
              error: "Run deadline exceeded",
              errorCode: "TIMED_OUT",
            }
          : undefined;
      if (classifiedOutcome) {
        const [run] = await tx
          .update(AgentRunTable)
          .set({
            ...terminalValues(classifiedOutcome),
            completedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          })
          .where(
            and(
              eq(AgentRunTable.id, id),
              eq(AgentRunTable.status, "running"),
              eq(AgentRunTable.leaseToken, leaseToken),
            ),
          )
          .returning();
        if (!run) return null;
        if (currentCheckpoint) {
          await tx
            .update(AgentRunCheckpointTable)
            .set({
              completedAt: now,
              claimToken: null,
              claimExpiresAt: null,
              updatedAt: now,
            })
            .where(eq(AgentRunCheckpointTable.parentRunId, id));
        }
        await tx
          .delete(AgentRunResumeDispatchTable)
          .where(eq(AgentRunResumeDispatchTable.parentRunId, id));
        return run;
      }
      const generation = (currentCheckpoint?.generation ?? 0) + 1;
      const requestedToolCallIds = [
        ...new Set(checkpoint.delegationToolCallIds),
      ];
      if (!requestedToolCallIds.length) return null;
      const joins = await tx
        .select({ toolCallId: AgentRunJoinTable.toolCallId })
        .from(AgentRunJoinTable)
        .where(
          and(
            eq(AgentRunJoinTable.parentRunId, id),
            eq(AgentRunJoinTable.checkpointGeneration, generation),
            inArray(AgentRunJoinTable.toolCallId, requestedToolCallIds),
          ),
        );
      if (
        joins.length !== requestedToolCallIds.length ||
        joins.some((join) => !requestedToolCallIds.includes(join.toolCallId))
      )
        return null;
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          status: "waiting_external",
          waitingReason: "DELEGATED_CHILDREN",
          lastHeartbeatAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, leaseToken),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .insert(AgentRunCheckpointTable)
        .values({ parentRunId: id, ...checkpoint })
        .onConflictDoUpdate({
          target: AgentRunCheckpointTable.parentRunId,
          set: {
            generation,
            responseMessages: checkpoint.responseMessages,
            modelMessages: checkpoint.modelMessages,
            modelConfig: checkpoint.modelConfig,
            authorizationRecipe: checkpoint.authorizationRecipe,
            assistantMessageId: checkpoint.assistantMessageId,
            claimToken: null,
            claimExpiresAt: null,
            completedAt: null,
            updatedAt: now,
          },
        });
      await tx.execute(sql`
        INSERT INTO agent_run_resume_dispatch
          (parent_run_id, generation, available_at, dispatched_at)
        SELECT checkpoint.parent_run_id, checkpoint.generation,
               CURRENT_TIMESTAMP, NULL
        FROM agent_run_checkpoint checkpoint
        WHERE checkpoint.parent_run_id = ${id}
          AND NOT EXISTS (
            SELECT 1 FROM agent_run_join pending
            WHERE pending.parent_run_id = ${id}
              AND pending.completed_at IS NULL
          )
        ON CONFLICT (parent_run_id) DO UPDATE SET
          generation = EXCLUDED.generation,
          available_at = EXCLUDED.available_at,
          dispatched_at = NULL
      `);
      return run;
    });
  },

  async claimParentResume(id, leaseMs) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const token = randomUUID();
      const [expired] = await tx
        .update(AgentRunTable)
        .set({
          status: "timed_out",
          completedAt: now,
          errorCode: "TIMED_OUT",
          error: "Parent deadline exceeded while waiting for delegated work",
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "waiting_external"),
            lte(AgentRunTable.absoluteDeadlineAt, now),
          ),
        )
        .returning({ id: AgentRunTable.id });
      if (expired) {
        await tx
          .update(AgentRunCheckpointTable)
          .set({ completedAt: now, updatedAt: now })
          .where(eq(AgentRunCheckpointTable.parentRunId, id));
        await tx
          .delete(AgentRunResumeDispatchTable)
          .where(eq(AgentRunResumeDispatchTable.parentRunId, id));
        return null;
      }
      const [row] = await tx
        .select({ run: AgentRunTable, checkpoint: AgentRunCheckpointTable })
        .from(AgentRunTable)
        .innerJoin(
          AgentRunCheckpointTable,
          eq(AgentRunCheckpointTable.parentRunId, AgentRunTable.id),
        )
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "waiting_external"),
            isNull(AgentRunTable.cancelRequestedAt),
            isNull(AgentRunCheckpointTable.completedAt),
          ),
        )
        .for("update");
      if (
        !row ||
        (row.run.absoluteDeadlineAt && row.run.absoluteDeadlineAt <= now) ||
        (row.checkpoint.claimExpiresAt && row.checkpoint.claimExpiresAt > now)
      )
        return null;
      const [pending] = await tx
        .select({ childRunId: AgentRunJoinTable.childRunId })
        .from(AgentRunJoinTable)
        .where(
          and(
            eq(AgentRunJoinTable.parentRunId, id),
            isNull(AgentRunJoinTable.completedAt),
          ),
        )
        .limit(1);
      if (pending) return null;
      const expiresAt = new Date(now.getTime() + leaseMs);
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          status: "running",
          waitingReason: null,
          leaseToken: token,
          leaseExpiresAt: expiresAt,
          lastHeartbeatAt: now,
          attempt: sql`${AgentRunTable.attempt} + 1`,
        })
        .where(eq(AgentRunTable.id, id))
        .returning();
      await tx
        .update(AgentRunCheckpointTable)
        .set({ claimToken: token, claimExpiresAt: expiresAt, updatedAt: now })
        .where(eq(AgentRunCheckpointTable.parentRunId, id));
      const joins = await tx
        .select()
        .from(AgentRunJoinTable)
        .where(
          and(
            eq(AgentRunJoinTable.parentRunId, id),
            eq(
              AgentRunJoinTable.checkpointGeneration,
              row.checkpoint.generation,
            ),
            isNotNull(AgentRunJoinTable.completedAt),
          ),
        );
      return {
        run,
        checkpoint: {
          generation: row.checkpoint.generation,
          delegationToolCallIds: [],
          responseMessages: row.checkpoint.responseMessages,
          modelMessages: row.checkpoint.modelMessages,
          modelConfig: row.checkpoint.modelConfig,
          authorizationRecipe: row.checkpoint.authorizationRecipe,
          assistantMessageId: row.checkpoint.assistantMessageId,
        },
        joins: joins.map((join) => ({
          checkpointGeneration: join.checkpointGeneration,
          toolCallId: join.toolCallId,
          childRunId: join.childRunId,
          observation: join.observation!,
        })),
        token,
      };
    });
  },

  async checkpointParentAgain(id, claimToken, checkpoint) {
    return this.suspendParent(id, claimToken, checkpoint);
  },

  async finishParentResume(id, claimToken, outcome) {
    return db.transaction(async (tx) => {
      const now = new Date();
      const [checkpoint] = await tx
        .select({
          parentRunId: AgentRunCheckpointTable.parentRunId,
          claimExpiresAt: AgentRunCheckpointTable.claimExpiresAt,
        })
        .from(AgentRunCheckpointTable)
        .where(
          and(
            eq(AgentRunCheckpointTable.parentRunId, id),
            eq(AgentRunCheckpointTable.claimToken, claimToken),
            isNull(AgentRunCheckpointTable.completedAt),
          ),
        )
        .for("update");
      if (!checkpoint?.claimExpiresAt || checkpoint.claimExpiresAt <= now)
        return null;
      const [leased] = await tx
        .select({
          status: AgentRunTable.status,
          leaseToken: AgentRunTable.leaseToken,
          leaseExpiresAt: AgentRunTable.leaseExpiresAt,
          cancelRequestedAt: AgentRunTable.cancelRequestedAt,
          absoluteDeadlineAt: AgentRunTable.absoluteDeadlineAt,
        })
        .from(AgentRunTable)
        .where(eq(AgentRunTable.id, id))
        .for("update");
      if (
        leased?.status !== "running" ||
        leased.leaseToken !== claimToken ||
        !leased.leaseExpiresAt ||
        leased.leaseExpiresAt <= now
      )
        return null;
      const classifiedOutcome: RunOutcome = leased.cancelRequestedAt
        ? {
            status: "cancelled",
            error: "Run was cancelled",
            errorCode: "CANCELLED",
          }
        : leased.absoluteDeadlineAt && leased.absoluteDeadlineAt <= now
          ? {
              status: "timed_out",
              error: "Run deadline exceeded",
              errorCode: "TIMED_OUT",
            }
          : outcome;
      const [run] = await tx
        .update(AgentRunTable)
        .set({
          ...terminalValues(classifiedOutcome),
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        })
        .where(
          and(
            eq(AgentRunTable.id, id),
            eq(AgentRunTable.status, "running"),
            eq(AgentRunTable.leaseToken, claimToken),
          ),
        )
        .returning();
      if (!run) return null;
      await tx
        .update(AgentRunCheckpointTable)
        .set({
          completedAt: now,
          claimToken: null,
          claimExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(AgentRunCheckpointTable.parentRunId, id));
      await tx
        .delete(AgentRunResumeDispatchTable)
        .where(eq(AgentRunResumeDispatchTable.parentRunId, id));
      return run;
    });
  },

  async listPendingParentResumeIds(limit) {
    const rows = await db
      .select({ parentRunId: AgentRunResumeDispatchTable.parentRunId })
      .from(AgentRunResumeDispatchTable)
      .where(
        and(
          lte(AgentRunResumeDispatchTable.availableAt, new Date()),
          or(
            isNull(AgentRunResumeDispatchTable.dispatchedAt),
            lte(
              AgentRunResumeDispatchTable.dispatchedAt,
              new Date(Date.now() - 60_000),
            ),
          ),
        ),
      )
      .limit(limit);
    return rows.map((row) => row.parentRunId);
  },

  async markParentResumeDispatched(id) {
    await db
      .update(AgentRunResumeDispatchTable)
      .set({
        dispatchedAt: new Date(),
        attempts: sql`${AgentRunResumeDispatchTable.attempts} + 1`,
      })
      .where(eq(AgentRunResumeDispatchTable.parentRunId, id));
  },
};
