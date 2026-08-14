import { getSession } from "auth/server";
import { and, desc, eq } from "drizzle-orm";
import { enqueueAutomationRun } from "lib/automation/queue";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable, AutomationTable } from "lib/db/pg/schema.pg";
import { z } from "zod";
import { isV2FeatureEnabled } from "lib/feature-flags";

const TriggerSchema = z.object({ approvalGranted: z.boolean().default(false) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const input = TriggerSchema.parse(await request.json().catch(() => ({})));
  const [automation] = await pgDb
    .select()
    .from(AutomationTable)
    .where(
      and(
        eq(AutomationTable.id, (await params).id),
        eq(AutomationTable.userId, session.user.id),
        eq(AutomationTable.status, "active"),
      ),
    );
  if (!automation)
    return Response.json({ error: "Automation not found" }, { status: 404 });
  const scheduledFor = new Date().toISOString();
  await enqueueAutomationRun({
    automationId: automation.id,
    scheduledFor,
    approvalGranted: input.approvalGranted,
  });
  return Response.json({ queued: true, scheduledFor }, { status: 202 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(
    await pgDb
      .select()
      .from(AutomationRunTable)
      .where(
        and(
          eq(AutomationRunTable.automationId, (await params).id),
          eq(AutomationRunTable.userId, session.user.id),
        ),
      )
      .orderBy(desc(AutomationRunTable.createdAt)),
  );
}
