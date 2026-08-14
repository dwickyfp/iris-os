import type PgBoss from "pg-boss";
import { and, eq, inArray, lt, or } from "drizzle-orm";
import { recordActivityEvent } from "lib/activity/service";
import { createAutomationExecutionAdapter } from "lib/automation/execution-adapter";
import {
  DELEGATION_EXECUTE_QUEUE,
  DELEGATION_SWEEP_QUEUE,
  enqueueDelegatedRun,
} from "lib/delegation/queue";
import { activeChildCount, DELEGATION_LIMITS } from "lib/delegation/service";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable, DelegationRunTable } from "lib/db/pg/schema.pg";

const executeTarget = createAutomationExecutionAdapter();

async function execute(childRunId: string) {
  const [child] = await pgDb
    .select()
    .from(AgentRunTable)
    .where(
      and(eq(AgentRunTable.id, childRunId), eq(AgentRunTable.status, "queued")),
    );
  if (!child || !child.parentRunId || !child.agentId) return;
  const [parent] = await pgDb
    .select()
    .from(AgentRunTable)
    .where(eq(AgentRunTable.id, child.parentRunId));
  if (!parent || parent.cancelRequestedAt || parent.status === "cancelled") {
    await finish(
      child,
      "cancelled",
      null,
      "PARENT_CANCELLED",
      "Parent cancelled",
    );
    return;
  }
  if (
    (await activeChildCount(parent.id)) >= DELEGATION_LIMITS.maxParallelChildren
  ) {
    await enqueueDelegatedRun(child.id, 5);
    return;
  }
  const [claimed] = await pgDb
    .update(AgentRunTable)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(eq(AgentRunTable.id, child.id), eq(AgentRunTable.status, "queued")),
    )
    .returning();
  if (!claimed) return;
  await pgDb
    .update(DelegationRunTable)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(DelegationRunTable.childRunId, child.id));
  await recordActivityEvent(child.userId, {
    actorType: "agent",
    actorId: child.agentId,
    scopeType: child.taskId
      ? "task"
      : child.workspaceId
        ? "workspace"
        : "agent",
    scopeId: child.taskId ?? child.workspaceId ?? child.agentId,
    eventType: "delegation.started",
    subjectType: "agent_run",
    subjectId: child.id,
    runId: child.id,
    parentRunId: parent.id,
    taskId: child.taskId ?? undefined,
    agentId: child.agentId,
    payload: { targetType: "agent" },
    idempotencyKey: `delegation.started:${child.id}`,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), child.timeoutMs);
  const poll = setInterval(() => {
    void pgDb
      .select({ cancel: AgentRunTable.cancelRequestedAt })
      .from(AgentRunTable)
      .where(
        or(eq(AgentRunTable.id, child.id), eq(AgentRunTable.id, parent.id)),
      )
      .then((rows) => {
        if (rows.some((row) => row.cancel)) controller.abort();
      })
      .catch(() => undefined);
  }, 1_000);
  const result = await executeTarget({
    runId: child.id,
    userId: child.userId,
    workspaceId: child.workspaceId ?? undefined,
    targetType: "agent",
    targetId: child.agentId,
    input: child.context,
    allowedTools: child.allowedTools,
    timeoutMs: child.timeoutMs,
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
    clearInterval(poll);
  });
  if (result.status === "succeeded")
    await finish(child, "succeeded", result.output, null, null);
  else if (result.status === "timed_out")
    await finish(child, "timed_out", null, "TIMED_OUT", result.message);
  else if (result.status === "cancelled")
    await finish(child, "cancelled", null, "CANCELLED", result.message ?? null);
  else await finish(child, "failed", null, result.errorCode, result.message);
}

async function finish(
  child: typeof AgentRunTable.$inferSelect,
  status: "succeeded" | "failed" | "cancelled" | "timed_out",
  result: Record<string, unknown> | null,
  errorCode: string | null,
  error: string | null,
) {
  const completedAt = new Date();
  await pgDb.transaction(async (tx) => {
    await tx
      .update(AgentRunTable)
      .set({ status, result, errorCode, error, completedAt })
      .where(eq(AgentRunTable.id, child.id));
    await tx
      .update(DelegationRunTable)
      .set({ status, result, errorCode, error, completedAt })
      .where(eq(DelegationRunTable.childRunId, child.id));
  });
  const eventType =
    status === "succeeded"
      ? "delegation.completed"
      : status === "cancelled"
        ? "delegation.cancelled"
        : status === "timed_out"
          ? "delegation.timed_out"
          : "delegation.failed";
  await recordActivityEvent(child.userId, {
    actorType: "agent",
    actorId: child.agentId ?? undefined,
    scopeType: child.taskId
      ? "task"
      : child.workspaceId
        ? "workspace"
        : child.agentId
          ? "agent"
          : "global",
    scopeId: child.taskId ?? child.workspaceId ?? child.agentId,
    eventType,
    subjectType: "agent_run",
    subjectId: child.id,
    runId: child.id,
    parentRunId: child.parentRunId ?? undefined,
    taskId: child.taskId ?? undefined,
    agentId: child.agentId ?? undefined,
    payload: { targetType: "agent", errorCode },
    idempotencyKey: `${eventType}:${child.id}`,
  });
}

export async function registerDelegationWorkers(boss: PgBoss) {
  await boss.createQueue(DELEGATION_EXECUTE_QUEUE);
  await boss.createQueue(DELEGATION_SWEEP_QUEUE);
  await boss.work<{ childRunId: string }>(
    DELEGATION_EXECUTE_QUEUE,
    { batchSize: DELEGATION_LIMITS.maxParallelChildren },
    async (jobs) => {
      for (const job of jobs) await execute(job.data.childRunId);
    },
  );
  await boss.work(DELEGATION_SWEEP_QUEUE, async () => {
    const stale = await pgDb
      .select({ id: AgentRunTable.id })
      .from(AgentRunTable)
      .where(
        and(
          inArray(AgentRunTable.status, ["queued", "running"]),
          lt(
            AgentRunTable.createdAt,
            new Date(Date.now() - DELEGATION_LIMITS.maxTimeoutMs),
          ),
        ),
      )
      .limit(100);
    for (const run of stale) await enqueueDelegatedRun(run.id);
  });
  await boss.schedule(DELEGATION_SWEEP_QUEUE, "*/5 * * * *", {});
}
