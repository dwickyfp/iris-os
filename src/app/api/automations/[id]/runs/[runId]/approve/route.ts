import { getSession } from "auth/server";
import { and, eq } from "drizzle-orm";
import { enqueueAutomationRun } from "lib/automation/queue";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const { id, runId } = await params;
  const [run] = await pgDb
    .update(AutomationRunTable)
    .set({
      status: "queued",
      approvalStatus: "approved",
      approvedBy: session.user.id,
      approvedAt: new Date(),
    })
    .where(
      and(
        eq(AutomationRunTable.id, runId),
        eq(AutomationRunTable.automationId, id),
        eq(AutomationRunTable.userId, session.user.id),
        eq(AutomationRunTable.status, "awaiting_approval"),
      ),
    )
    .returning();
  if (!run)
    return Response.json(
      { error: "Run is not awaiting approval" },
      { status: 409 },
    );
  await enqueueAutomationRun(run.id);
  return Response.json(run);
}
