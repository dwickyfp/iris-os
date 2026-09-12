import "server-only";

import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable, type AutomationTable } from "lib/db/pg/schema.pg";
import { generateUUID } from "lib/utils";
import { resolveAutomationAuthority } from "./authority";
import { automationRunKey } from "./idempotency";
import { enqueueAutomationRun } from "./queue";

export async function createDurableAutomationRun(input: {
  automation: typeof AutomationTable.$inferSelect;
  scheduledFor: Date;
  approvedBy?: string;
}) {
  // Full-background operation: automation runs never wait for a human
  // approval. Authority is still resolved server-side at creation from the
  // automation target and user ownership.
  const requiresApproval = false;
  const approved = false;
  const authorized = true;
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
