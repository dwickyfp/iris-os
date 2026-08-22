import type PgBoss from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import { recordActivityEvent } from "lib/activity/service";
import {
  createAutomationExecutionAdapter,
  projectAutomationExecutionResult,
} from "lib/automation/execution-adapter";
import {
  AUTOMATION_EXECUTE_QUEUE,
  AUTOMATION_REFRESH_QUEUE,
  enqueueAutomationRun,
} from "lib/automation/queue";
import { createDurableAutomationRun } from "lib/automation/service";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AutomationRunAttemptTable,
  AutomationRunTable,
  AutomationTable,
} from "lib/db/pg/schema.pg";
import { generateUUID } from "lib/utils";
import { resolveAutomationAuthority } from "lib/automation/authority";
import {
  buildAutomationWorkerRequest,
  resolveWorkerAutomationAuthority,
} from "lib/automation/worker-context";

const executeTarget = createAutomationExecutionAdapter();

async function execute(runId: string) {
  const [joined] = await pgDb
    .select({ run: AutomationRunTable, automation: AutomationTable })
    .from(AutomationRunTable)
    .innerJoin(
      AutomationTable,
      eq(AutomationRunTable.automationId, AutomationTable.id),
    )
    .where(eq(AutomationRunTable.id, runId));
  if (!joined) return;
  const { run, automation } = joined;
  if (
    !["queued", "retry_scheduled"].includes(run.status) ||
    automation.status !== "active"
  )
    return;
  if (
    automation.approvalPolicy !== "never" &&
    run.approvalStatus !== "approved"
  )
    return;
  if (run.cancelRequestedAt) {
    await pgDb
      .update(AutomationRunTable)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(AutomationRunTable.id, run.id));
    return;
  }
  let authority;
  try {
    authority = resolveWorkerAutomationAuthority({
      persisted: run.authorizationContext,
      current: await resolveAutomationAuthority({
        targetType: automation.targetType,
        targetId: automation.targetId,
        userId: automation.userId,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pgDb
      .update(AutomationRunTable)
      .set({
        status: "failed",
        errorCode: "AUTHORITY_SNAPSHOT_INVALID",
        error: message.slice(0, 2_000),
        retryable: false,
        completedAt: new Date(),
      })
      .where(eq(AutomationRunTable.id, run.id));
    return;
  }

  const attempt = run.attempt + 1;
  const attemptId = generateUUID();
  const [claimed] = await pgDb.transaction(async (tx) => {
    const rows = await tx
      .update(AutomationRunTable)
      .set({
        status: "running",
        attempt,
        startedAt: run.startedAt ?? new Date(),
        nextAttemptAt: null,
        error: null,
        errorCode: null,
        retryable: false,
      })
      .where(
        and(
          eq(AutomationRunTable.id, run.id),
          inArray(AutomationRunTable.status, ["queued", "retry_scheduled"]),
        ),
      )
      .returning();
    if (!rows[0]) return [];
    await tx.insert(AutomationRunAttemptTable).values({
      id: attemptId,
      runId: run.id,
      attempt,
      status: "running",
    });
    return rows;
  });
  if (!claimed) return;

  await recordActivityEvent(automation.userId, {
    actorType: "system",
    scopeType: automation.workspaceId ? "workspace" : "global",
    scopeId: automation.workspaceId,
    eventType: "automation.started",
    subjectType: "automation_run",
    subjectId: run.id,
    runId: run.id,
    payload: { targetType: automation.targetType, attempt },
    idempotencyKey: `automation.started:${run.id}:${attempt}`,
  });

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Run timed out", "TimeoutError")),
    automation.timeoutMs,
  );
  const cancellationPoll = setInterval(() => {
    void pgDb
      .select({ cancelRequestedAt: AutomationRunTable.cancelRequestedAt })
      .from(AutomationRunTable)
      .where(eq(AutomationRunTable.id, run.id))
      .then(([current]) => {
        if (current?.cancelRequestedAt)
          controller.abort(new DOMException("Run was cancelled", "AbortError"));
      })
      .catch(() => undefined);
  }, 1_000);
  const result = await executeTarget(
    buildAutomationWorkerRequest({
      run,
      automation,
      authority,
      signal: controller.signal,
    }),
  ).finally(() => {
    clearTimeout(timeout);
    clearInterval(cancellationPoll);
  });

  const projection = projectAutomationExecutionResult(result);
  const { retryable, error, errorCode, output } = projection;
  const retry = retryable && attempt <= automation.retryLimit;
  const delaySeconds = Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
  const status = retry
    ? "retry_scheduled"
    : projection.status;

  await pgDb.transaction(async (tx) => {
    await tx
      .update(AutomationRunAttemptTable)
      .set({
        status: projection.attemptStatus,
        result: output,
        error,
        errorCode,
        completedAt: new Date(),
      })
      .where(eq(AutomationRunAttemptTable.id, attemptId));
    await tx
      .update(AutomationRunTable)
      .set({
        status,
        result: output,
        error,
        errorCode,
        retryable,
        nextAttemptAt: retry
          ? new Date(Date.now() + delaySeconds * 1_000)
          : null,
        completedAt: retry ? null : new Date(),
      })
      .where(eq(AutomationRunTable.id, run.id));
  });
  if (retry) await enqueueAutomationRun(run.id, delaySeconds);

  const eventType = retry
    ? "automation.retried"
    : result.status === "succeeded"
      ? "automation.completed"
      : result.status === "budget_exhausted"
        ? "automation.budget_exhausted"
      : result.status === "cancelled"
        ? "automation.cancelled"
        : "automation.failed";
  await recordActivityEvent(automation.userId, {
    actorType: "system",
    scopeType: automation.workspaceId ? "workspace" : "global",
    scopeId: automation.workspaceId,
    eventType,
    subjectType: "automation_run",
    subjectId: run.id,
    runId: run.id,
    payload: {
      targetType: automation.targetType,
      attempt,
      retryable,
      errorCode,
      toStatus: status,
    },
    idempotencyKey: `${eventType}:${run.id}:${attempt}`,
  });
}

export async function registerAutomationWorkers(boss: PgBoss) {
  await boss.createQueue(AUTOMATION_EXECUTE_QUEUE);
  await boss.createQueue(AUTOMATION_REFRESH_QUEUE);
  await boss.work<{ runId: string }>(
    AUTOMATION_EXECUTE_QUEUE,
    { batchSize: 4 },
    async (jobs) => {
      for (const job of jobs) await execute(job.data.runId);
    },
  );
  const registered = new Set<string>();
  const refresh = async (automationId: string) => {
    const queueName = `automation-schedule-${automationId}`;
    if (registered.has(queueName)) {
      await boss.unschedule(queueName);
      await boss.offWork(queueName);
      registered.delete(queueName);
    }
    const [automation] = await pgDb
      .select()
      .from(AutomationTable)
      .where(eq(AutomationTable.id, automationId));
    if (
      !automation ||
      automation.status !== "active" ||
      automation.triggerType !== "schedule" ||
      !automation.cron
    )
      return;
    await boss.createQueue(queueName);
    await boss.schedule(
      queueName,
      automation.cron,
      { automationId },
      { tz: automation.timezone },
    );
    await boss.work<{ automationId: string }>(
      queueName,
      { includeMetadata: true },
      async (jobs) => {
        for (const job of jobs)
          await createDurableAutomationRun({
            automation,
            scheduledFor: job.createdOn,
          });
      },
    );
    registered.add(queueName);
  };
  await boss.work<{ automationId: string }>(
    AUTOMATION_REFRESH_QUEUE,
    { batchSize: 4 },
    async (jobs) => {
      for (const job of jobs) await refresh(job.data.automationId);
    },
  );
  const scheduled = await pgDb
    .select({ id: AutomationTable.id })
    .from(AutomationTable)
    .where(
      and(
        eq(AutomationTable.status, "active"),
        eq(AutomationTable.triggerType, "schedule"),
      ),
    );
  for (const automation of scheduled) await refresh(automation.id);
}
