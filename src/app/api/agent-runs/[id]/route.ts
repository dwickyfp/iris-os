import { getSession } from "auth/server";
import { and, eq } from "drizzle-orm";
import { runManager } from "lib/ai/runs/server";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable, DelegationRunTable } from "lib/db/pg/schema.pg";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const [run] = await pgDb
    .select()
    .from(AgentRunTable)
    .where(
      and(
        eq(AgentRunTable.id, (await params).id),
        eq(AgentRunTable.userId, session.user.id),
      ),
    );
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  const [children, delegations] = await Promise.all([
    pgDb
      .select()
      .from(AgentRunTable)
      .where(eq(AgentRunTable.parentRunId, run.id)),
    pgDb
      .select()
      .from(DelegationRunTable)
      .where(eq(DelegationRunTable.parentRunId, run.id)),
  ]);
  return run
    ? Response.json({ ...run, children, delegations })
    : Response.json({ error: "Run not found" }, { status: 404 });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const runId = (await params).id;
  const run = await runManager.requestCancellation(runId, session.user.id);
  return run
    ? Response.json(run)
    : Response.json({ error: "Run not found" }, { status: 404 });
}
