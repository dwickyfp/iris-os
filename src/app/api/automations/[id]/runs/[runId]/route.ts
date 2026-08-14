import { getSession } from "auth/server";
import { and, eq, isNull } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AutomationRunAttemptTable,
  AutomationRunTable,
} from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const { id, runId } = await params;
  const [run, attempts] = await Promise.all([
    pgDb
      .select()
      .from(AutomationRunTable)
      .where(
        and(
          eq(AutomationRunTable.id, runId),
          eq(AutomationRunTable.automationId, id),
          eq(AutomationRunTable.userId, session.user.id),
        ),
      )
      .then(([value]) => value),
    pgDb
      .select()
      .from(AutomationRunAttemptTable)
      .where(eq(AutomationRunAttemptTable.runId, runId)),
  ]);
  return run
    ? Response.json({ run, attempts })
    : Response.json({ error: "Run not found" }, { status: 404 });
}

export async function DELETE(
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
    .set({ cancelRequestedAt: new Date() })
    .where(
      and(
        eq(AutomationRunTable.id, runId),
        eq(AutomationRunTable.automationId, id),
        eq(AutomationRunTable.userId, session.user.id),
        isNull(AutomationRunTable.completedAt),
      ),
    )
    .returning();
  return run
    ? Response.json(run)
    : Response.json({ error: "Active run not found" }, { status: 404 });
}
