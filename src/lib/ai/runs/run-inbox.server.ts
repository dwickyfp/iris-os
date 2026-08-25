import "server-only";

import { and, desc, eq, isNull } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunCheckpointTable,
  AgentRunJoinTable,
  AgentRunTable,
  RootRunGoalTable,
  RunInboxTable,
} from "lib/db/pg/schema.pg";
import type { NormalizedGoalRequirement } from "../runtime/goal-requirement-resolver";

export type RunInboxMode = "followup" | "steer" | "inject";
export type RunInboxSource =
  | "user"
  | "system"
  | "a2a"
  | "workflow"
  | "job"
  | "automation";

export async function listRunInbox(userId: string, limit = 100) {
  return pgDb
    .select()
    .from(RunInboxTable)
    .where(
      and(eq(RunInboxTable.userId, userId), eq(RunInboxTable.status, "open")),
    )
    .orderBy(desc(RunInboxTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function enqueueRunInbox(input: {
  userId: string;
  rootRunId?: string;
  targetRunId?: string;
  mode: RunInboxMode;
  source: RunInboxSource;
  content: Record<string, unknown>;
  goalRevision?: number;
  idempotencyKey: string;
}) {
  const [item] = await pgDb
    .insert(RunInboxTable)
    .values(input)
    .onConflictDoNothing()
    .returning();
  if (item) return item;
  const [existing] = await pgDb
    .select()
    .from(RunInboxTable)
    .where(
      and(
        eq(RunInboxTable.userId, input.userId),
        eq(RunInboxTable.idempotencyKey, input.idempotencyKey),
      ),
    );
  return existing;
}

export async function reviseRunGoal(input: {
  rootRunId: string;
  userId: string;
  expectedRevision: number;
  requirement: NormalizedGoalRequirement;
  sourceMessageId?: string;
  content: Record<string, unknown>;
  idempotencyKey: string;
}) {
  return pgDb.transaction(async (tx) => {
    const [replayed] = await tx
      .select()
      .from(RunInboxTable)
      .where(
        and(
          eq(RunInboxTable.userId, input.userId),
          eq(RunInboxTable.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (replayed?.goalRevision)
      return { revision: replayed.goalRevision, item: replayed };
    const [root] = await tx
      .select({ userId: AgentRunTable.userId })
      .from(AgentRunTable)
      .where(
        and(
          eq(AgentRunTable.id, input.rootRunId),
          eq(AgentRunTable.rootRunId, input.rootRunId),
        ),
      )
      .for("update");
    if (!root || root.userId !== input.userId)
      throw new Error("RUN_GOAL_NOT_FOUND");
    const [rootState] = await tx
      .select({
        status: AgentRunTable.status,
        continuationKind: AgentRunCheckpointTable.continuationKind,
        verificationFeedback: AgentRunCheckpointTable.verificationFeedback,
      })
      .from(AgentRunTable)
      .innerJoin(
        AgentRunCheckpointTable,
        eq(AgentRunCheckpointTable.parentRunId, AgentRunTable.id),
      )
      .where(eq(AgentRunTable.id, input.rootRunId));
    if (
      !rootState ||
      rootState.status !== "waiting_external" ||
      rootState.continuationKind !== "goal"
    )
      throw new Error("RUN_GOAL_NOT_AT_SAFE_BOUNDARY");
    const [pendingJoin] = await tx
      .select({ childRunId: AgentRunJoinTable.childRunId })
      .from(AgentRunJoinTable)
      .where(
        and(
          eq(AgentRunJoinTable.parentRunId, input.rootRunId),
          isNull(AgentRunJoinTable.completedAt),
        ),
      )
      .limit(1);
    if (pendingJoin) throw new Error("RUN_GOAL_NOT_AT_SAFE_BOUNDARY");
    const [goal] = await tx
      .select()
      .from(RootRunGoalTable)
      .where(eq(RootRunGoalTable.rootRunId, input.rootRunId))
      .for("update");
    if (!goal || goal.revision !== input.expectedRevision)
      throw new Error("RUN_GOAL_REVISION_CONFLICT");
    const revision = goal.revision + 1;
    await tx
      .update(RootRunGoalTable)
      .set({
        revision,
        requirement: input.requirement,
        sourceMessageId: input.sourceMessageId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(RootRunGoalTable.rootRunId, input.rootRunId));
    await tx
      .update(AgentRunTable)
      .set({
        goalRevision: revision,
        goalRequirement: input.requirement,
      })
      .where(eq(AgentRunTable.id, input.rootRunId));
    await tx
      .update(AgentRunCheckpointTable)
      .set({
        verificationFeedback: {
          ...(rootState.verificationFeedback ?? {}),
          steer: input.content,
          goalRevision: revision,
        },
        updatedAt: new Date(),
      })
      .where(eq(AgentRunCheckpointTable.parentRunId, input.rootRunId));
    await tx
      .update(RunInboxTable)
      .set({ status: "superseded", consumedAt: new Date() })
      .where(
        and(
          eq(RunInboxTable.rootRunId, input.rootRunId),
          eq(RunInboxTable.status, "open"),
          isNull(RunInboxTable.consumedAt),
        ),
      );
    const [item] = await tx
      .insert(RunInboxTable)
      .values({
        userId: input.userId,
        rootRunId: input.rootRunId,
        targetRunId: input.rootRunId,
        mode: "steer",
        source: "user",
        content: input.content,
        goalRevision: revision,
        idempotencyKey: input.idempotencyKey,
        status: "consumed",
        consumedAt: new Date(),
      })
      .returning();
    return { revision, item };
  });
}

export async function consumeRunInbox(input: {
  id: string;
  userId: string;
  targetRunId: string;
}) {
  return pgDb.transaction(async (tx) => {
    const [item] = await tx
      .update(RunInboxTable)
      .set({ status: "consumed", consumedAt: new Date() })
      .where(
        and(
          eq(RunInboxTable.id, input.id),
          eq(RunInboxTable.userId, input.userId),
          eq(RunInboxTable.targetRunId, input.targetRunId),
          eq(RunInboxTable.status, "open"),
        ),
      )
      .returning();
    if (!item) return null;
    const [run] = await tx
      .select({ rootRunId: AgentRunTable.rootRunId })
      .from(AgentRunTable)
      .where(
        and(
          eq(AgentRunTable.id, input.targetRunId),
          eq(AgentRunTable.userId, input.userId),
        ),
      );
    if (!run || run.rootRunId !== item.rootRunId)
      throw new Error("RUN_INBOX_TARGET_INVALID");
    return item;
  });
}

export async function dismissRunInbox(id: string, userId: string) {
  const [item] = await pgDb
    .update(RunInboxTable)
    .set({ status: "dismissed", consumedAt: new Date() })
    .where(
      and(
        eq(RunInboxTable.id, id),
        eq(RunInboxTable.userId, userId),
        eq(RunInboxTable.status, "open"),
      ),
    )
    .returning();
  return item ?? null;
}
