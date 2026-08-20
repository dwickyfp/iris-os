import { getSession } from "auth/server";
import { desc, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable, DelegationRunTable } from "lib/db/pg/schema.pg";

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
    summary: {
      active: runs.filter((run) =>
        [
          "queued",
          "running",
          "waiting_approval",
          "waiting_input",
          "waiting_external",
        ].includes(run.status),
      ).length,
      failed: runs.filter((run) => ["failed", "timed_out"].includes(run.status))
        .length,
      cancellable: runs.filter(
        (run) =>
          [
            "queued",
            "running",
            "waiting_approval",
            "waiting_input",
            "waiting_external",
          ].includes(run.status) && run.cancelRequestedAt === null,
      ).length,
    },
  });
}
