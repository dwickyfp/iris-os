import type { WorkspaceRepository } from "lib/workspace/service";
import { and, desc, eq } from "drizzle-orm";
import { pgDb as db } from "../db.pg";
import { WorkspaceTable } from "../schema.pg";

function toWorkspace(row: typeof WorkspaceTable.$inferSelect) {
  return {
    ...row,
    description: row.description ?? undefined,
    instructions: row.instructions ?? undefined,
    defaultModelId: row.defaultModelId ?? undefined,
    defaultAgentId: row.defaultAgentId ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

export const pgWorkspaceRepository: WorkspaceRepository = {
  async listByUserId(userId, status) {
    const rows = await db
      .select()
      .from(WorkspaceTable)
      .where(
        status
          ? and(
              eq(WorkspaceTable.userId, userId),
              eq(WorkspaceTable.status, status),
            )
          : eq(WorkspaceTable.userId, userId),
      )
      .orderBy(desc(WorkspaceTable.updatedAt));
    return rows.map(toWorkspace);
  },

  async selectById(id, userId) {
    const [workspace] = await db
      .select()
      .from(WorkspaceTable)
      .where(and(eq(WorkspaceTable.id, id), eq(WorkspaceTable.userId, userId)));
    return workspace ? toWorkspace(workspace) : null;
  },

  async insert(userId, input) {
    const [workspace] = await db
      .insert(WorkspaceTable)
      .values({ ...input, userId })
      .returning();
    return toWorkspace(workspace);
  },

  async update(id, userId, input) {
    const [workspace] = await db
      .update(WorkspaceTable)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(WorkspaceTable.id, id), eq(WorkspaceTable.userId, userId)))
      .returning();
    return workspace ? toWorkspace(workspace) : null;
  },
};
