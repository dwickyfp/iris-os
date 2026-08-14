import { WorkspaceUpdateSchema } from "app-types/workspace";
import { getSession } from "auth/server";
import { workspaceRepository } from "lib/db/repository";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { workspaceService } from "lib/workspace/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  ChatThreadTable,
  WorkspaceDeletionTombstoneTable,
  WorkspaceTable,
} from "lib/db/pg/schema.pg";
import { generateUUID } from "lib/utils";

function unavailable() {
  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isV2FeatureEnabled("workspaces")) return unavailable();
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const workspace = await workspaceRepository.selectById(id, session.user.id);
  return workspace
    ? Response.json(workspace)
    : Response.json({ error: "Workspace not found" }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isV2FeatureEnabled("workspaces")) return unavailable();
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { id } = await params;
    const input = WorkspaceUpdateSchema.parse(await request.json());
    return Response.json(
      await workspaceService.update(session.user.id, id, input),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Workspace not found")
      return Response.json({ error: error.message }, { status: 404 });
    return Response.json(
      { error: error instanceof z.ZodError ? error.issues : "Invalid request" },
      { status: 400 },
    );
  }
}

const PurgeSchema = z.object({
  cascadeInternal: z.boolean().default(false),
  confirmation: z.literal("DELETE WORKSPACE"),
});

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isV2FeatureEnabled("workspaces")) return unavailable();
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const input = PurgeSchema.parse(await request.json());
  const workspaceId = (await params).id;
  const workspace = await workspaceRepository.selectById(
    workspaceId,
    session.user.id,
  );
  if (!workspace)
    return Response.json({ error: "Workspace not found" }, { status: 404 });

  const counts = await pgDb.execute<{
    threads: number;
    tasks: number;
    memories: number;
    automations: number;
    scopedRecords: number;
  }>(sql`SELECT
    (SELECT count(*)::int FROM chat_thread WHERE workspace_id = ${workspaceId}) AS threads,
    (SELECT count(*)::int FROM iris_task WHERE workspace_id = ${workspaceId}) AS tasks,
    (SELECT count(*)::int FROM user_memory WHERE scope_type = 'workspace' AND scope_id = ${workspaceId}) AS memories,
    (SELECT count(*)::int FROM automation WHERE workspace_id = ${workspaceId}) AS automations,
    (
      (SELECT count(*) FROM learning_candidate WHERE scope_type = 'workspace' AND scope_id = ${workspaceId})
      + (SELECT count(*) FROM learning_observation WHERE scope_type = 'workspace' AND scope_id = ${workspaceId})
      + (SELECT count(*) FROM iris_activity_event WHERE scope_type = 'workspace' AND scope_id = ${workspaceId})
      + (SELECT count(*) FROM memory_retrieval_audit WHERE scope_type = 'workspace' AND scope_id = ${workspaceId})
      + (SELECT count(*) FROM memory_curator_run WHERE scope_type = 'workspace' AND scope_id = ${workspaceId})
    )::int AS "scopedRecords"`);
  const sanitizedCounts = counts.rows[0] ?? {
    threads: 0,
    tasks: 0,
    memories: 0,
    automations: 0,
    scopedRecords: 0,
  };
  if (
    Object.values(sanitizedCounts).some((count) => count > 0) &&
    !input.cascadeInternal
  ) {
    return Response.json(
      { error: "Workspace contains internal data", counts: sanitizedCounts },
      { status: 409 },
    );
  }

  await pgDb.transaction(async (tx) => {
    if (input.cascadeInternal) {
      const scopedToWorkspaceOrTask = sql`
        (scope_type = 'workspace' AND scope_id = ${workspaceId})
        OR (
          scope_type = 'task'
          AND scope_id IN (
            SELECT id FROM iris_task WHERE workspace_id = ${workspaceId}
          )
        )`;

      // Polymorphic scope ids have no FK, so purge every scoped table before
      // deleting its workspace/tasks to avoid leaving inaccessible private data.
      await tx.execute(
        sql`DELETE FROM learning_candidate WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM learning_observation WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM memory_retrieval_audit WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM memory_curator_run WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM memory_edge WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM memory_evidence WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM memory_embedding WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM memory_topic WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM memory_entity WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(
        sql`DELETE FROM user_memory WHERE ${scopedToWorkspaceOrTask}`,
      );
      await tx.execute(sql`DELETE FROM iris_activity_event
        WHERE ${scopedToWorkspaceOrTask}
        OR task_id IN (
          SELECT id FROM iris_task WHERE workspace_id = ${workspaceId}
        )`);
      await tx.execute(
        sql`DELETE FROM agent_run WHERE workspace_id = ${workspaceId}`,
      );
      await tx.execute(
        sql`DELETE FROM automation WHERE workspace_id = ${workspaceId}`,
      );
      await tx
        .update(ChatThreadTable)
        .set({ workspaceId: null, taskId: null })
        .where(eq(ChatThreadTable.workspaceId, workspaceId));
      await tx.execute(
        sql`DELETE FROM iris_task WHERE workspace_id = ${workspaceId}`,
      );
    }
    await tx
      .delete(WorkspaceTable)
      .where(
        and(
          eq(WorkspaceTable.id, workspaceId),
          eq(WorkspaceTable.userId, session.user.id),
        ),
      );
    await tx.insert(WorkspaceDeletionTombstoneTable).values({
      id: generateUUID(),
      workspaceIdHash: createHash("sha256").update(workspaceId).digest("hex"),
      userIdHash: createHash("sha256").update(session.user.id).digest("hex"),
      sanitizedCounts,
    });
  });
  return new Response(null, { status: 204 });
}
