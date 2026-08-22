import { getSession } from "auth/server";
import { desc, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable, DelegationRunTable } from "lib/db/pg/schema.pg";
import {
  summarizeAgentRunStatuses,
} from "lib/ai/runs/status";

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const runs = await pgDb
    .select()
    .from(AgentRunTable)
    .where(eq(AgentRunTable.userId, session.user.id))
    .orderBy(desc(AgentRunTable.createdAt))
    .limit(100);
  const delegations = await pgDb
    .select()
    .from(DelegationRunTable)
    .where(eq(DelegationRunTable.userId, session.user.id))
    .orderBy(desc(DelegationRunTable.createdAt))
    .limit(100);
  return Response.json({
    roots: runs.filter((run) => run.parentRunId === null),
    runs,
    delegations,
    summary: summarizeAgentRunStatuses(runs),
  });
}
