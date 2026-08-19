import { and, desc, eq } from "drizzle-orm";
import type { RemoteAgentRepository } from "lib/remote-agent/service";
import { pgDb as db } from "../db.pg";
import { RemoteAgentTable } from "../schema.pg";

export const pgRemoteAgentRepository: RemoteAgentRepository = {
  async listByUserId(userId) {
    return db
      .select()
      .from(RemoteAgentTable)
      .where(eq(RemoteAgentTable.userId, userId))
      .orderBy(desc(RemoteAgentTable.updatedAt));
  },

  async selectById(id, userId) {
    const [agent] = await db
      .select()
      .from(RemoteAgentTable)
      .where(
        and(eq(RemoteAgentTable.id, id), eq(RemoteAgentTable.userId, userId)),
      );
    return agent ?? null;
  },

  async insert(userId, input) {
    const [agent] = await db
      .insert(RemoteAgentTable)
      .values({ ...input, userId })
      .returning();
    return agent;
  },

  async update(id, userId, input) {
    const [agent] = await db
      .update(RemoteAgentTable)
      .set({ ...input, updatedAt: new Date() })
      .where(
        and(eq(RemoteAgentTable.id, id), eq(RemoteAgentTable.userId, userId)),
      )
      .returning();
    return agent ?? null;
  },

  async delete(id, userId) {
    const rows = await db
      .delete(RemoteAgentTable)
      .where(
        and(eq(RemoteAgentTable.id, id), eq(RemoteAgentTable.userId, userId)),
      )
      .returning({ id: RemoteAgentTable.id });
    return rows.length > 0;
  },
};
