import { and, desc, eq } from "drizzle-orm";
import type {
  IrisTask,
  ResourceRefCreateData,
  TaskCreateData,
  TaskUpdateData,
} from "app-types/task";
import { assertTaskTransition } from "lib/task/state";
import {
  insertActivityEvent,
  publishActivityEvent,
} from "lib/activity/service";
import { generateUUID } from "lib/utils";
import { pgDb as db } from "../db.pg";
import {
  TaskActivityTable,
  TaskResourceRefTable,
  TaskTable,
} from "../schema.pg";

function toTask(row: typeof TaskTable.$inferSelect): IrisTask {
  return {
    ...row,
    workspaceId: row.workspaceId ?? undefined,
    parentTaskId: row.parentTaskId ?? undefined,
    assignedAgentId: row.assignedAgentId ?? undefined,
    description: row.description ?? undefined,
    nextAction: row.nextAction ?? undefined,
    checkpoint: row.checkpoint ?? undefined,
    dueAt: row.dueAt ?? undefined,
    startedAt: row.startedAt ?? undefined,
    blockedAt: row.blockedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    cancelledAt: row.cancelledAt ?? undefined,
  };
}

export const pgTaskRepository = {
  async list(userId: string, workspaceId?: string) {
    const rows = await db
      .select()
      .from(TaskTable)
      .where(
        workspaceId
          ? and(
              eq(TaskTable.userId, userId),
              eq(TaskTable.workspaceId, workspaceId),
            )
          : eq(TaskTable.userId, userId),
      )
      .orderBy(desc(TaskTable.updatedAt));
    return rows.map(toTask);
  },

  async select(id: string, userId: string) {
    const [row] = await db
      .select()
      .from(TaskTable)
      .where(and(eq(TaskTable.id, id), eq(TaskTable.userId, userId)));
    return row ? toTask(row) : null;
  },

  async create(userId: string, input: TaskCreateData) {
    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(TaskTable)
        .values({ ...input, id: generateUUID(), userId })
        .returning();
      const activityId = generateUUID();
      await tx.insert(TaskActivityTable).values({
        id: activityId,
        taskId: row.id,
        userId,
        type: "created",
        payload: { status: row.status },
      });
      const event = await insertActivityEvent(tx, userId, {
        actorType: "user",
        scopeType: "task",
        scopeId: row.id,
        eventType: "task.created",
        subjectType: "task",
        subjectId: row.id,
        taskId: row.id,
        payload: { toStatus: row.status },
        idempotencyKey: `task.created:${activityId}`,
      });
      return { task: toTask(row), eventId: event.id };
    });
    publishActivityEvent(created.eventId);
    return created.task;
  },

  async update(id: string, userId: string, input: TaskUpdateData) {
    const updated = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(TaskTable)
        .where(and(eq(TaskTable.id, id), eq(TaskTable.userId, userId)))
        .limit(1);
      if (!current) return null;
      if (input.status) assertTaskTransition(current.status, input.status);
      const now = new Date();
      const timestamps =
        input.status === "in_progress"
          ? { startedAt: current.startedAt ?? now, blockedAt: null }
          : input.status === "blocked"
            ? { blockedAt: now }
            : input.status === "completed"
              ? { completedAt: now }
              : input.status === "cancelled"
                ? { cancelledAt: now }
                : {};
      const [row] = await tx
        .update(TaskTable)
        .set({ ...input, ...timestamps, updatedAt: now })
        .where(and(eq(TaskTable.id, id), eq(TaskTable.userId, userId)))
        .returning();
      const activityId = generateUUID();
      const activityType = input.checkpoint
        ? "checkpointed"
        : input.status && input.status !== current.status
          ? "status_changed"
          : "updated";
      await tx.insert(TaskActivityTable).values({
        id: activityId,
        taskId: id,
        userId,
        type: activityType,
        payload: {
          fromStatus: current.status,
          toStatus: row.status,
          nextAction: row.nextAction,
        },
      });
      const eventType =
        row.status === "completed"
          ? "task.completed"
          : activityType === "checkpointed"
            ? "task.checkpointed"
            : "task.status_changed";
      const event = await insertActivityEvent(tx, userId, {
        actorType: "user",
        scopeType: "task",
        scopeId: row.id,
        eventType,
        subjectType: "task",
        subjectId: row.id,
        taskId: row.id,
        payload: {
          fromStatus: current.status,
          toStatus: row.status,
        },
        idempotencyKey: `${eventType}:${activityId}`,
      });
      return { task: toTask(row), eventId: event.id };
    });
    if (!updated) return null;
    publishActivityEvent(updated.eventId);
    return updated.task;
  },

  async detail(id: string, userId: string) {
    const task = await this.select(id, userId);
    if (!task) return null;
    const [activities, resources] = await Promise.all([
      db
        .select()
        .from(TaskActivityTable)
        .where(
          and(
            eq(TaskActivityTable.taskId, id),
            eq(TaskActivityTable.userId, userId),
          ),
        )
        .orderBy(desc(TaskActivityTable.createdAt)),
      db
        .select()
        .from(TaskResourceRefTable)
        .where(
          and(
            eq(TaskResourceRefTable.taskId, id),
            eq(TaskResourceRefTable.userId, userId),
          ),
        ),
    ]);
    return { task, activities, resources };
  },

  async addResource(id: string, userId: string, input: ResourceRefCreateData) {
    if (!(await this.select(id, userId))) return null;
    const created = await db.transaction(async (tx) => {
      const resourceId = generateUUID();
      const [resource] = await tx
        .insert(TaskResourceRefTable)
        .values({ ...input, id: resourceId, taskId: id, userId })
        .onConflictDoUpdate({
          target: [
            TaskResourceRefTable.taskId,
            TaskResourceRefTable.kind,
            TaskResourceRefTable.referenceId,
          ],
          set: { label: input.label, metadata: input.metadata },
        })
        .returning();
      const event = await insertActivityEvent(tx, userId, {
        actorType: "user",
        scopeType: "task",
        scopeId: id,
        eventType: "resource.attached",
        subjectType: "resource",
        subjectId: resource.id,
        taskId: id,
        payload: { kind: input.kind },
        idempotencyKey: `resource.attached:${resource.id}`,
      });
      return { resource, eventId: event.id };
    });
    publishActivityEvent(created.eventId);
    return created.resource;
  },
};
