import { getSession } from "auth/server";
import { AutomationUpdateSchema } from "app-types/automation";
import { and, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { enqueueAutomationRefresh } from "lib/automation/queue";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const input = AutomationUpdateSchema.parse(await request.json());
  const [automation] = await pgDb
    .update(AutomationTable)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(
        eq(AutomationTable.id, (await params).id),
        eq(AutomationTable.userId, session.user.id),
      ),
    )
    .returning();
  if (automation) void enqueueAutomationRefresh(automation.id);
  return automation
    ? Response.json(automation)
    : Response.json({ error: "Automation not found" }, { status: 404 });
}
