import type { MCPRepository } from "app-types/mcp";
import { desc, eq, or } from "drizzle-orm";
import {
  decryptMcpServerConfig,
  encryptMcpServerConfig,
} from "lib/security/mcp-credential-crypto";
import { generateUUID } from "lib/utils";
import { pgDb as db } from "../db.pg";
import { McpServerTable, UserTable } from "../schema.pg";

/** Column type as stored in the database (an envelope string after encryption). */
type StoredConfig = (typeof McpServerTable.$inferInsert)["config"];

function encryptConfig(config: unknown): StoredConfig {
  return encryptMcpServerConfig(config) as unknown as StoredConfig;
}

function withDecryptedConfig<T extends { config: unknown }>(row: T): T {
  return {
    ...row,
    config: decryptMcpServerConfig(row.config) ?? row.config,
  };
}

export const pgMcpRepository: MCPRepository = {
  async save(server) {
    const [result] = await db
      .insert(McpServerTable)
      .values({
        id: server.id ?? generateUUID(),
        name: server.name,
        // Credentials (auth headers, env vars) are encrypted at rest.
        config: encryptConfig(server.config),
        userId: server.userId,
        visibility: server.visibility ?? "private",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [McpServerTable.id],
        set: {
          config: encryptConfig(server.config),
          updatedAt: new Date(),
        },
      })
      .returning();

    return withDecryptedConfig(result);
  },

  async selectById(id) {
    const [result] = await db
      .select()
      .from(McpServerTable)
      .where(eq(McpServerTable.id, id));
    return result ? withDecryptedConfig(result) : null;
  },

  async selectAll() {
    const results = await db.select().from(McpServerTable);
    return results.map(withDecryptedConfig);
  },

  async selectAllForUser(userId) {
    // Get user's own MCP servers and featured ones
    const results = await db
      .select({
        id: McpServerTable.id,
        name: McpServerTable.name,
        config: McpServerTable.config,
        enabled: McpServerTable.enabled,
        userId: McpServerTable.userId,
        visibility: McpServerTable.visibility,
        lastConnectionStatus: McpServerTable.lastConnectionStatus,
        createdAt: McpServerTable.createdAt,
        updatedAt: McpServerTable.updatedAt,
        userName: UserTable.name,
        userAvatar: UserTable.image,
      })
      .from(McpServerTable)
      .leftJoin(UserTable, eq(McpServerTable.userId, UserTable.id))
      .where(
        or(
          eq(McpServerTable.userId, userId),
          eq(McpServerTable.visibility, "public"),
        ),
      )
      .orderBy(desc(McpServerTable.createdAt));
    return results.map(withDecryptedConfig);
  },

  async updateVisibility(id, visibility) {
    await db
      .update(McpServerTable)
      .set({ visibility, updatedAt: new Date() })
      .where(eq(McpServerTable.id, id));
  },

  async deleteById(id) {
    await db.delete(McpServerTable).where(eq(McpServerTable.id, id));
  },

  async selectByServerName(name) {
    const [result] = await db
      .select()
      .from(McpServerTable)
      .where(eq(McpServerTable.name, name));
    return result ? withDecryptedConfig(result) : null;
  },
  async updateToolInfo(id, toolInfo) {
    await db
      .update(McpServerTable)
      .set({
        toolInfo,
        toolInfoUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(McpServerTable.id, id));
  },

  async updateConnectionStatus(id, status) {
    await db
      .update(McpServerTable)
      .set({
        lastConnectionStatus: status,
        updatedAt: new Date(),
      })
      .where(eq(McpServerTable.id, id));
  },

  async existsByServerName(name) {
    const [result] = await db
      .select({ id: McpServerTable.id })
      .from(McpServerTable)
      .where(eq(McpServerTable.name, name));

    return !!result;
  },
};
