import { getSession } from "auth/server";
import { and, eq, sql } from "drizzle-orm";
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
  const [run] = await pgDb.transaction(async (tx) => {
    const rows = await tx
      .update(AgentRunTable)
      .set({ cancelRequestedAt: new Date() })
      .where(
        and(
          eq(AgentRunTable.id, runId),
          eq(AgentRunTable.userId, session.user.id),
        ),
      )
      .returning();
    if (!rows[0]) return [];
    await tx.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id FROM agent_run WHERE parent_run_id = ${runId}
        UNION ALL
        SELECT child.id FROM agent_run child
        JOIN descendants parent ON child.parent_run_id = parent.id
      )
      UPDATE agent_run
      SET cancel_requested_at = CURRENT_TIMESTAMP,
          status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
          completed_at = CASE WHEN status = 'queued' THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id IN (SELECT id FROM descendants)
        AND user_id = ${session.user.id}
        AND status IN ('queued', 'running')
    `);
    await tx.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id FROM agent_run WHERE parent_run_id = ${runId}
        UNION ALL
        SELECT child.id FROM agent_run child
        JOIN descendants parent ON child.parent_run_id = parent.id
      )
      UPDATE delegation_run
      SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP,
          error_code = 'PARENT_CANCELLED', error = 'Parent cancelled'
      WHERE child_run_id IN (SELECT id FROM descendants)
        AND user_id = ${session.user.id}
        AND status = 'queued'
    `);
    return rows;
  });
  return run
    ? Response.json(run)
    : Response.json({ error: "Run not found" }, { status: 404 });
}
