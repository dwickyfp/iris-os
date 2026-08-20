import { getSession } from "auth/server";
import { and, asc, eq } from "drizzle-orm";
import { getRunTrajectory } from "lib/activity/trajectory";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable, DelegationRunTable } from "lib/db/pg/schema.pg";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const runId = (await params).id;
  const [run] = await pgDb
    .select()
    .from(AgentRunTable)
    .where(
      and(
        eq(AgentRunTable.id, runId),
        eq(AgentRunTable.userId, session.user.id),
      ),
    );
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  const [events, delegations] = await Promise.all([
    getRunTrajectory(pgDb, session.user.id, run.rootRunId),
    pgDb
      .select()
      .from(DelegationRunTable)
      .where(
        and(
          eq(DelegationRunTable.userId, session.user.id),
          eq(DelegationRunTable.parentRunId, runId),
        ),
      )
      .orderBy(asc(DelegationRunTable.createdAt)),
  ]);
  return Response.json({ run, events, delegations });
}
