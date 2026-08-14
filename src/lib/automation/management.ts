import "server-only";

import {
  AutomationCreateSchema,
  AutomationUpdateSchema,
  type AutomationCreateData,
} from "app-types/automation";
import { and, desc, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationTable } from "lib/db/pg/schema.pg";
import {
  agentRepository,
  skillRepository,
  workflowRepository,
  workspaceRepository,
} from "lib/db/repository";
import { generateUUID } from "lib/utils";
import { enqueueAutomationRefresh } from "./queue";
import { createDurableAutomationRun } from "./service";

async function assertTargetAccess(
  userId: string,
  input: Pick<AutomationCreateData, "targetType" | "targetId">,
) {
  const targetExists =
    input.targetType === "workflow"
      ? await workflowRepository.checkAccess(input.targetId, userId)
      : input.targetType === "skill"
        ? Boolean(await skillRepository.selectSkillById(input.targetId, userId))
        : Boolean(await agentRepository.selectAgentById(input.targetId, userId));
  if (!targetExists) throw new Error("AUTOMATION_TARGET_NOT_FOUND");
}

async function validateAutomation(userId: string, input: AutomationCreateData) {
  if (input.triggerType === "schedule" && !input.cron)
    throw new Error("AUTOMATION_CRON_REQUIRED");
  if (
    input.workspaceId &&
    !(await workspaceRepository.selectById(input.workspaceId, userId))
  )
    throw new Error("AUTOMATION_WORKSPACE_NOT_FOUND");
  await assertTargetAccess(userId, input);
}

export async function listManagedAutomations(userId: string) {
  return pgDb
    .select()
    .from(AutomationTable)
    .where(eq(AutomationTable.userId, userId))
    .orderBy(desc(AutomationTable.updatedAt));
}

export async function createManagedAutomation(
  userId: string,
  raw: AutomationCreateData,
) {
  const input = AutomationCreateSchema.parse(raw);
  await validateAutomation(userId, input);
  const [automation] = await pgDb
    .insert(AutomationTable)
    .values({ ...input, id: generateUUID(), userId })
    .returning();
  if (automation.triggerType === "schedule")
    void enqueueAutomationRefresh(automation.id);
  return automation;
}

export async function updateManagedAutomation(
  userId: string,
  automationId: string,
  raw: unknown,
) {
  const update = AutomationUpdateSchema.parse(raw);
  const [current] = await pgDb
    .select()
    .from(AutomationTable)
    .where(
      and(
        eq(AutomationTable.id, automationId),
        eq(AutomationTable.userId, userId),
      ),
    );
  if (!current) throw new Error("AUTOMATION_NOT_FOUND");
  const merged = AutomationCreateSchema.parse({ ...current, ...update });
  await validateAutomation(userId, merged);
  const [automation] = await pgDb
    .update(AutomationTable)
    .set({ ...update, updatedAt: new Date() })
    .where(
      and(
        eq(AutomationTable.id, automationId),
        eq(AutomationTable.userId, userId),
      ),
    )
    .returning();
  void enqueueAutomationRefresh(automation.id);
  return automation;
}

export async function triggerManagedAutomation(
  userId: string,
  automationId: string,
) {
  const [automation] = await pgDb
    .select()
    .from(AutomationTable)
    .where(
      and(
        eq(AutomationTable.id, automationId),
        eq(AutomationTable.userId, userId),
        eq(AutomationTable.status, "active"),
      ),
    );
  if (!automation) throw new Error("AUTOMATION_NOT_FOUND");
  return createDurableAutomationRun({ automation, scheduledFor: new Date() });
}
