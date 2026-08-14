import { getSession } from "auth/server";
import { and, desc, eq } from "drizzle-orm";
import { createDurableAutomationRun } from "lib/automation/service";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable, AutomationTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
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
  const scheduledFor = new Date();
  const run = await createDurableAutomationRun({
    automation,
    scheduledFor,
  });
  return Response.json(
    {
      queued: run?.status === "queued",
      runId: run?.id,
      status: run?.status,
      scheduledFor: scheduledFor.toISOString(),
    },
    { status: 202 },
  );
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
