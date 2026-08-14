import { getSession } from "auth/server";
import { and, eq, inArray } from "drizzle-orm";
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
      nextAttemptAt: null,
      completedAt: null,
      error: null,
      errorCode: null,
    })
    .where(
      and(
        eq(AutomationRunTable.id, runId),
        eq(AutomationRunTable.automationId, id),
        eq(AutomationRunTable.userId, session.user.id),
        eq(AutomationRunTable.retryable, true),
        inArray(AutomationRunTable.status, ["failed", "timed_out"]),
      ),
    )
    .returning();
  if (!run)
    return Response.json({ error: "Run cannot be retried" }, { status: 409 });
  await enqueueAutomationRun(run.id);
  return Response.json(run);
}
