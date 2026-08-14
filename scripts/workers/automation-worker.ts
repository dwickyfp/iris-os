import type PgBoss from "pg-boss";
import { and, eq } from "drizzle-orm";
import {
  AUTOMATION_EXECUTE_QUEUE,
  AUTOMATION_REFRESH_QUEUE,
} from "lib/automation/queue";
import { automationRunKey } from "lib/automation/idempotency";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable, AutomationTable } from "lib/db/pg/schema.pg";
import { generateUUID } from "lib/utils";
import { workflowRepository } from "lib/db/repository";
import { createWorkflowExecutor } from "lib/ai/workflow/executor/workflow-executor";

type AutomationJob = {
  automationId: string;
  scheduledFor: string;
  approvalGranted?: boolean;
};

async function execute(job: AutomationJob) {
  const scheduledFor = new Date(job.scheduledFor);
  const key = automationRunKey(job.automationId, scheduledFor);
  const [automation] = await pgDb
    .select()
    .from(AutomationTable)
    .where(
      and(
        eq(AutomationTable.id, job.automationId),
        eq(AutomationTable.status, "active"),
      ),
    );
  if (!automation) return;
  const [run] = await pgDb
    .insert(AutomationRunTable)
    .values({
      id: generateUUID(),
      automationId: automation.id,
      userId: automation.userId,
      idempotencyKey: key,
      scheduledFor,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return;
  if (automation.approvalPolicy === "always" && !job.approvalGranted) {
    await pgDb
      .update(AutomationRunTable)
      .set({
        status: "failed",
        error: "Runtime approval required",
        completedAt: new Date(),
      })
      .where(eq(AutomationRunTable.id, run.id));
    return;
  }
  await pgDb
    .update(AutomationRunTable)
    .set({ status: "running", startedAt: new Date(), attempt: 1 })
    .where(eq(AutomationRunTable.id, run.id));
  try {
    if (automation.targetType !== "workflow") {
      throw new Error(
        `${automation.targetType} automation adapter is not enabled`,
      );
    }
    if (
      !(await workflowRepository.checkAccess(
        automation.targetId,
        automation.userId,
      ))
    )
      throw new Error("Automation workflow is no longer accessible");
    const workflow = await workflowRepository.selectStructureById(
      automation.targetId,
    );
    if (!workflow) throw new Error("Automation workflow not found");
    const executor = createWorkflowExecutor({
      edges: workflow.edges,
      nodes: workflow.nodes,
    });
    const outcome = await executor.run(automation.input as any, {
      disableHistory: true,
      timeout: 300_000,
    });
    if (!outcome.isOk) throw outcome.error;
    await pgDb
      .update(AutomationRunTable)
      .set({
        status: "succeeded",
        result: { targetType: "workflow", targetId: automation.targetId },
        completedAt: new Date(),
      })
      .where(eq(AutomationRunTable.id, run.id));
  } catch (error) {
    await pgDb
      .update(AutomationRunTable)
      .set({
        status: "failed",
        error:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : String(error),
        completedAt: new Date(),
      })
      .where(eq(AutomationRunTable.id, run.id));
    throw error;
  }
}

export async function registerAutomationWorkers(boss: PgBoss) {
  await boss.createQueue(AUTOMATION_EXECUTE_QUEUE);
  await boss.createQueue(AUTOMATION_REFRESH_QUEUE);
  await boss.work<AutomationJob>(
    AUTOMATION_EXECUTE_QUEUE,
    { batchSize: 4 },
    async (jobs) => {
      for (const job of jobs) await execute(job.data);
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
          await execute({
            automationId: job.data.automationId,
            scheduledFor: job.createdOn.toISOString(),
            approvalGranted: false,
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
