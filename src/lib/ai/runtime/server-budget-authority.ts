import "server-only";

import { and, eq, lte, ne, sql } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunTable,
  RootRunBudgetReservationTable,
  RootRunBudgetTable,
} from "lib/db/pg/schema.pg";
import { BudgetExhaustedError, type BudgetKind } from "./budget";

export type DurableBudgetKind =
  | "steps"
  | "tokens"
  | "tool_calls"
  | "delegations"
  | "children"
  | "sandbox_compute_ms";

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

const columns = {
  steps: ["committed_steps", "reserved_steps", "max_steps", "maxSteps"],
  tokens: ["committed_tokens", "reserved_tokens", "max_tokens", "maxTokens"],
  tool_calls: [
    "committed_tool_calls",
    "reserved_tool_calls",
    "max_tool_calls",
    "maxToolCalls",
  ],
  delegations: [
    "committed_delegations",
    "reserved_delegations",
    "max_delegations",
    "maxDelegations",
  ],
  children: [
    "committed_children",
    "reserved_children",
    "max_parallel_children",
    "maxParallel",
  ],
  sandbox_compute_ms: [
    "committed_sandbox_compute_ms",
    "reserved_sandbox_compute_ms",
    "max_sandbox_compute_ms",
    "maxComputeMs",
  ],
} as const;

const properties = {
  steps: ["committedSteps", "reservedSteps", "maxSteps"],
  tokens: ["committedTokens", "reservedTokens", "maxTokens"],
  tool_calls: ["committedToolCalls", "reservedToolCalls", "maxToolCalls"],
  delegations: [
    "committedDelegations",
    "reservedDelegations",
    "maxDelegations",
  ],
  children: ["committedChildren", "reservedChildren", "maxParallelChildren"],
  sandbox_compute_ms: [
    "committedSandboxComputeMs",
    "reservedSandboxComputeMs",
    "maxSandboxComputeMs",
  ],
} as const;

function exhausted(kind: DurableBudgetKind | "duration", committed = 0): never {
  const budgetKind =
    kind === "duration" ? "maxDurationMs" : (columns[kind][3] as BudgetKind);
  const usage = { ...zeroUsage };
  if (kind === "tokens") usage.tokens = committed;
  if (kind === "tool_calls") usage.toolCalls = committed;
  if (kind === "delegations") usage.delegations = committed;
  if (kind === "sandbox_compute_ms") usage.computeMs = committed;
  throw new BudgetExhaustedError(budgetKind, usage);
}

type Transaction = Parameters<Parameters<typeof pgDb.transaction>[0]>[0];

async function rootForRun(tx: Transaction, runId: string) {
  const [run] = await tx
    .select({ rootRunId: AgentRunTable.rootRunId })
    .from(AgentRunTable)
    .where(eq(AgentRunTable.id, runId));
  if (!run) throw new Error("ROOT_RUN_BUDGET_RUN_NOT_FOUND");
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`root-budget:${run.rootRunId}`}, 0))`,
  );
  const [budget] = await tx
    .select()
    .from(RootRunBudgetTable)
    .where(eq(RootRunBudgetTable.rootRunId, run.rootRunId))
    .for("update");
  if (!budget) throw new Error("ROOT_RUN_BUDGET_NOT_FOUND");
  if (Date.now() - budget.createdAt.getTime() >= budget.maxDurationMs)
    exhausted("duration");
  return { rootRunId: run.rootRunId, budget };
}

const terminalRunStates = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

async function canReleaseExpiredReservation(
  tx: Transaction,
  reservation: typeof RootRunBudgetReservationTable.$inferSelect,
) {
  if (reservation.kind === "sandbox_compute_ms") return false;
  const runId =
    reservation.kind === "children" && reservation.token.startsWith("child:")
      ? reservation.token.slice("child:".length)
      : reservation.runId;
  const [run] = await tx
    .select({ status: AgentRunTable.status })
    .from(AgentRunTable)
    .where(eq(AgentRunTable.id, runId));
  return Boolean(
    run &&
      terminalRunStates.includes(
        run.status as (typeof terminalRunStates)[number],
      ),
  );
}

export const serverBudgetAuthority = {
  async charge(
    runId: string,
    token: string,
    kind: DurableBudgetKind,
    amount: number,
  ) {
    if (!Number.isInteger(amount) || amount < 0)
      throw new RangeError("Budget charge must be a non-negative integer");
    if (amount === 0) return false;
    await pgDb.transaction(async (tx) => {
      const { rootRunId, budget } = await rootForRun(tx, runId);
      const [existing] = await tx
        .select()
        .from(RootRunBudgetReservationTable)
        .where(eq(RootRunBudgetReservationTable.token, token));
      if (existing) {
        if (
          existing.rootRunId !== rootRunId ||
          existing.runId !== runId ||
          existing.kind !== kind ||
          existing.amount !== amount ||
          existing.state !== "committed" ||
          existing.committedAmount !== amount
        )
          throw new Error("ROOT_RUN_BUDGET_RESERVATION_MISMATCH");
        return false;
      }
      const [committed] = columns[kind];
      const [committedProperty, reservedProperty, limitProperty] =
        properties[kind];
      const current = budget[committedProperty];
      const reservedValue = budget[reservedProperty];
      const limitValue = budget[limitProperty];
      if (current + reservedValue + amount > limitValue)
        exhausted(kind, current);
      await tx.execute(
        sql.raw(
          `UPDATE root_run_budget SET ${committed} = ${committed} + ${amount}, updated_at = CURRENT_TIMESTAMP WHERE root_run_id = '${rootRunId}'`,
        ),
      );
      await tx.insert(RootRunBudgetReservationTable).values({
        token,
        rootRunId,
        runId,
        kind,
        amount,
        state: "committed",
        committedAmount: amount,
        expiresAt: new Date(),
        settledAt: new Date(),
      });
      return true;
    });
  },

  async reserve(input: {
    runId: string;
    token: string;
    kind: DurableBudgetKind;
    amount: number;
    expiresAt: Date;
  }) {
    return pgDb.transaction(async (tx) => {
      const { rootRunId, budget } = await rootForRun(tx, input.runId);
      const [existing] = await tx
        .select()
        .from(RootRunBudgetReservationTable)
        .where(eq(RootRunBudgetReservationTable.token, input.token));
      if (existing) {
        if (
          existing.rootRunId !== rootRunId ||
          existing.runId !== input.runId ||
          existing.kind !== input.kind ||
          existing.amount !== input.amount
        )
          throw new Error("ROOT_RUN_BUDGET_RESERVATION_MISMATCH");
        return existing.state;
      }
      const [, reserved] = columns[input.kind];
      const [committedProperty, reservedProperty, limitProperty] =
        properties[input.kind];
      if (
        budget[committedProperty] + budget[reservedProperty] + input.amount >
        budget[limitProperty]
      )
        exhausted(input.kind, budget[committedProperty]);
      await tx.execute(
        sql.raw(
          `UPDATE root_run_budget SET ${reserved} = ${reserved} + ${input.amount}, updated_at = CURRENT_TIMESTAMP WHERE root_run_id = '${rootRunId}'`,
        ),
      );
      await tx.insert(RootRunBudgetReservationTable).values({
        token: input.token,
        rootRunId,
        runId: input.runId,
        kind: input.kind,
        amount: input.amount,
        expiresAt: input.expiresAt,
      });
      return "reserved" as const;
    });
  },

  async settle(token: string, committedAmount: number | null) {
    return pgDb.transaction(async (tx) => {
      const [reservation] = await tx
        .select()
        .from(RootRunBudgetReservationTable)
        .where(eq(RootRunBudgetReservationTable.token, token));
      if (!reservation)
        throw new Error("ROOT_RUN_BUDGET_RESERVATION_NOT_FOUND");
      await rootForRun(tx, reservation.runId);
      if (reservation.state !== "reserved") {
        if (
          reservation.state ===
            (committedAmount === null ? "released" : "committed") &&
          reservation.committedAmount === committedAmount
        )
          return false;
        throw new Error("ROOT_RUN_BUDGET_SETTLEMENT_MISMATCH");
      }
      if (
        committedAmount !== null &&
        (!Number.isInteger(committedAmount) ||
          committedAmount < 0 ||
          committedAmount > reservation.amount)
      )
        throw new RangeError("Budget settlement exceeds reservation");
      const [committed, reserved] = columns[reservation.kind];
      await tx.execute(
        sql.raw(
          `UPDATE root_run_budget SET ${reserved} = ${reserved} - ${reservation.amount}, ${committed} = ${committed} + ${committedAmount ?? 0}, updated_at = CURRENT_TIMESTAMP WHERE root_run_id = '${reservation.rootRunId}'`,
        ),
      );
      await tx
        .update(RootRunBudgetReservationTable)
        .set({
          state: committedAmount === null ? "released" : "committed",
          committedAmount,
          settledAt: new Date(),
        })
        .where(
          and(
            eq(RootRunBudgetReservationTable.token, token),
            eq(RootRunBudgetReservationTable.state, "reserved"),
          ),
        );
      return true;
    });
  },

  async reconcileExpiredReservations(limit = 100) {
    if (!Number.isInteger(limit) || limit <= 0)
      throw new RangeError("Reconciliation limit must be a positive integer");
    const candidates = await pgDb
      .select({
        token: RootRunBudgetReservationTable.token,
        rootRunId: RootRunBudgetReservationTable.rootRunId,
      })
      .from(RootRunBudgetReservationTable)
      .where(
        and(
          eq(RootRunBudgetReservationTable.state, "reserved"),
          lte(RootRunBudgetReservationTable.expiresAt, new Date()),
          ne(RootRunBudgetReservationTable.kind, "sandbox_compute_ms"),
        ),
      )
      .limit(limit);
    let released = 0;
    for (const candidate of candidates) {
      released += await pgDb.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`root-budget:${candidate.rootRunId}`}, 0))`,
        );
        const [reservation] = await tx
          .select()
          .from(RootRunBudgetReservationTable)
          .where(eq(RootRunBudgetReservationTable.token, candidate.token))
          .for("update");
        if (
          !reservation ||
          reservation.state !== "reserved" ||
          reservation.expiresAt > new Date() ||
          !(await canReleaseExpiredReservation(tx, reservation))
        )
          return 0;
        const [settled] = await tx
          .update(RootRunBudgetReservationTable)
          .set({
            state: "released",
            committedAmount: null,
            settledAt: new Date(),
          })
          .where(
            and(
              eq(RootRunBudgetReservationTable.token, reservation.token),
              eq(RootRunBudgetReservationTable.state, "reserved"),
            ),
          )
          .returning({ amount: RootRunBudgetReservationTable.amount });
        if (!settled) return 0;
        const [, reservedColumn] = columns[reservation.kind];
        await tx.execute(
          sql.raw(
            `UPDATE root_run_budget SET ${reservedColumn} = ${reservedColumn} - ${settled.amount}, updated_at = CURRENT_TIMESTAMP WHERE root_run_id = '${reservation.rootRunId}'`,
          ),
        );
        return 1;
      });
    }
    return released;
  },
};
