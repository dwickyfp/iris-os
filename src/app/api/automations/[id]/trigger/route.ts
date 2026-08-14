import { getSession } from "auth/server";
import { and, desc, eq } from "drizzle-orm";
import { triggerManagedAutomation } from "lib/automation/management";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable } from "lib/db/pg/schema.pg";
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
  const scheduledFor = new Date();
  const run = await triggerManagedAutomation(session.user.id, (await params).id);
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
