import { getSession } from "auth/server";
import { and, asc, eq, or } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunTable,
  DelegationRunTable,
  IrisActivityEventTable,
} from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("delegation"))
    return Response.json({ error: "Not found" }, { status: 404 });
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
    pgDb
      .select()
      .from(IrisActivityEventTable)
      .where(
        and(
          eq(IrisActivityEventTable.userId, session.user.id),
          or(
            eq(IrisActivityEventTable.runId, runId),
            eq(IrisActivityEventTable.parentRunId, runId),
          ),
        ),
      )
      .orderBy(asc(IrisActivityEventTable.createdAt)),
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
