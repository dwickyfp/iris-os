import { getSession } from "auth/server";
import { and, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable } from "lib/db/pg/schema.pg";

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
  return run
    ? Response.json(run)
    : Response.json({ error: "Run not found" }, { status: 404 });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const [run] = await pgDb
    .update(AgentRunTable)
    .set({ status: "cancelled", cancelRequestedAt: new Date() })
    .where(
      and(
        eq(AgentRunTable.id, (await params).id),
        eq(AgentRunTable.userId, session.user.id),
      ),
    )
    .returning();
  return run
    ? Response.json(run)
    : Response.json({ error: "Run not found" }, { status: 404 });
}
