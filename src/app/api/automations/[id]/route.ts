import { getSession } from "auth/server";
import { and, desc, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AutomationRunTable, AutomationTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { updateManagedAutomation } from "lib/automation/management";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const id = (await params).id;
  const [automation, runs] = await Promise.all([
    pgDb
      .select()
      .from(AutomationTable)
      .where(
        and(
          eq(AutomationTable.id, id),
          eq(AutomationTable.userId, session.user.id),
        ),
      )
      .then(([value]) => value),
    pgDb
      .select()
      .from(AutomationRunTable)
      .where(
        and(
          eq(AutomationRunTable.automationId, id),
          eq(AutomationRunTable.userId, session.user.id),
        ),
      )
      .orderBy(desc(AutomationRunTable.createdAt)),
  ]);
  return automation
    ? Response.json({ automation, runs })
    : Response.json({ error: "Automation not found" }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("automation"))
    return Response.json({ error: "Not found" }, { status: 404 });
  try {
    return Response.json(
      await updateManagedAutomation(
        session.user.id,
        (await params).id,
        await request.json(),
      ),
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid automation" },
      { status: 400 },
    );
  }
}
