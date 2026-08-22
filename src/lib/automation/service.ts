import "server-only";

import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable, type AutomationTable } from "lib/db/pg/schema.pg";
import { generateUUID } from "lib/utils";
import { automationRunKey } from "./idempotency";
import { enqueueAutomationRun } from "./queue";
import { resolveAutomationAuthority } from "./authority";

export async function createDurableAutomationRun(input: {
  automation: typeof AutomationTable.$inferSelect;
  scheduledFor: Date;
  approvedBy?: string;
}) {
  // Until every workflow node exposes a trusted read-only classification,
  // destructive_only remains fail-closed and requires a durable grant.
  const requiresApproval = input.automation.approvalPolicy !== "never";
  const approved = requiresApproval && Boolean(input.approvedBy);
  const authorized = !requiresApproval || approved;
  const authorizationContext = authorized
    ? await resolveAutomationAuthority({
        targetType: input.automation.targetType,
        targetId: input.automation.targetId,
        userId: input.automation.userId,
      })
    : null;
  const [created] = await pgDb
    .insert(AutomationRunTable)
    .values({
      id: generateUUID(),
      automationId: input.automation.id,
      userId: input.automation.userId,
      idempotencyKey: automationRunKey(input.automation.id, input.scheduledFor),
      scheduledFor: input.scheduledFor,
      status: requiresApproval && !approved ? "awaiting_approval" : "queued",
      approvalStatus: requiresApproval
        ? approved
          ? "approved"
          : "pending"
        : "not_required",
      approvedBy: approved ? input.approvedBy : null,
      approvedAt: approved ? new Date() : null,
      authorizationContext,
    })
    .onConflictDoNothing()
    .returning();
  if (created) {
    if (created.status === "queued") await enqueueAutomationRun(created.id);
    return created;
  }
  const [existing] = await pgDb
    .select()
    .from(AutomationRunTable)
    .where(
      eq(
        AutomationRunTable.idempotencyKey,
        automationRunKey(input.automation.id, input.scheduledFor),
      ),
    );
  return existing;
}
