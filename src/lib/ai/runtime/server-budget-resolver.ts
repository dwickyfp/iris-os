import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable, RootRunBudgetTable } from "lib/db/pg/schema.pg";
import type { RunBudget } from "./budget";
import { narrowServerBudget } from "./budget-resolution";
import type { RunPreparationInput } from "./run-preparer";

const defaults = {
  chat: {
    maxSteps: 10,
    maxTokens: 50_000,
    maxDurationMs: 90_000,
    maxToolCalls: 32,
    maxDelegations: 8,
    maxDepth: 3,
    maxParallel: 8,
    maxComputeMs: 300_000,
  },
  automation: {
    maxSteps: 10,
    maxTokens: 50_000,
    maxDurationMs: 300_000,
    maxToolCalls: 32,
    maxDelegations: 8,
    maxDepth: 3,
    maxParallel: 8,
    maxComputeMs: 300_000,
  },
  delegation: {
    maxSteps: 10,
    maxTokens: 50_000,
    maxDurationMs: 300_000,
    maxToolCalls: 32,
    maxDelegations: 8,
    maxDepth: 3,
    maxParallel: 8,
    maxComputeMs: 300_000,
  },
  resume: {
    maxSteps: 10,
    maxTokens: 50_000,
    maxDurationMs: 300_000,
    maxToolCalls: 32,
    maxDelegations: 8,
    maxDepth: 3,
    maxParallel: 8,
    maxComputeMs: 300_000,
  },
} satisfies Record<NonNullable<RunPreparationInput["surface"]>, RunBudget>;

function snapshot(row: typeof RootRunBudgetTable.$inferSelect): RunBudget {
  return {
    maxSteps: row.maxSteps,
    maxTokens: row.maxTokens,
    maxDurationMs: row.maxDurationMs,
    maxToolCalls: row.maxToolCalls,
    maxDelegations: row.maxDelegations,
    maxDepth: row.maxDelegationDepth,
    maxParallel: row.maxParallelChildren,
    maxComputeMs: row.maxSandboxComputeMs,
  };
}

/** Resolves server limits; persisted root authority always wins over client snapshots. */
export async function serverBudgetResolver(
  input: RunPreparationInput,
): Promise<RunBudget> {
  if (input.runId) {
    const [persisted] = await pgDb
      .select({
        budget: RootRunBudgetTable,
        userId: AgentRunTable.userId,
        parentRunId: AgentRunTable.parentRunId,
        tokenBudget: AgentRunTable.tokenBudget,
        absoluteDeadlineAt: AgentRunTable.absoluteDeadlineAt,
        remainingDurationMs:
          sql<number>`GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${AgentRunTable.absoluteDeadlineAt} - CURRENT_TIMESTAMP)) * 1000))`.mapWith(
            Number,
          ),
      })
      .from(AgentRunTable)
      .innerJoin(
        RootRunBudgetTable,
        eq(RootRunBudgetTable.rootRunId, AgentRunTable.rootRunId),
      )
      .where(
        and(
          eq(AgentRunTable.id, input.runId),
          input.userId ? eq(AgentRunTable.userId, input.userId) : undefined,
        ),
      );
    if (!persisted) throw new Error("ROOT_RUN_BUDGET_NOT_FOUND");
    const childBudget: RunBudget | undefined = persisted.parentRunId
      ? {
          maxTokens: persisted.tokenBudget,
          ...(persisted.absoluteDeadlineAt
            ? {
                 maxDurationMs: persisted.remainingDurationMs,
              }
            : {}),
        }
      : undefined;
    return narrowServerBudget(
      narrowServerBudget(
        narrowServerBudget(snapshot(persisted.budget), childBudget),
        input.requestedBudget,
      ),
      input.restore?.budget,
    );
  }
  const base = defaults[input.surface ?? "automation"];
  return narrowServerBudget(
    narrowServerBudget(base, input.requestedBudget),
    input.restore?.budget,
  );
}

export function rootBudgetValues(budget: RunBudget) {
  const resolved = narrowServerBudget(defaults.automation, budget);
  return {
    maxSteps: resolved.maxSteps!,
    maxTokens: resolved.maxTokens!,
    maxDurationMs: resolved.maxDurationMs!,
    maxToolCalls: resolved.maxToolCalls!,
    maxDelegations: resolved.maxDelegations!,
    maxDelegationDepth: resolved.maxDepth!,
    maxParallelChildren: resolved.maxParallel!,
    maxSandboxComputeMs: resolved.maxComputeMs!,
  };
}
