import { McpOAuthRepository, McpOAuthSession } from "app-types/mcp";
import { and, desc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import {
  decryptMcpOAuthSecrets,
  encryptMcpOAuthSecrets,
} from "lib/security/mcp-credential-crypto";
import { pgDb as db } from "../db.pg";
import { McpOAuthSessionTable } from "../schema.pg";

// OAuth repository implementation for multi-instance support.
// Credential fields (tokens, clientInfo, codeVerifier) are encrypted at rest.
export const pgMcpOAuthRepository: McpOAuthRepository = {
  // 1. Query methods

  // Get session with valid tokens (authenticated)
  getAuthenticatedSession: async (mcpServerId) => {
    const [session] = await db
      .select()
      .from(McpOAuthSessionTable)
      .where(
        and(
          eq(McpOAuthSessionTable.mcpServerId, mcpServerId),
          isNotNull(McpOAuthSessionTable.tokens),
        ),
      )
      .orderBy(desc(McpOAuthSessionTable.updatedAt))
      .limit(1);

    return session
      ? (decryptMcpOAuthSecrets(session) as McpOAuthSession)
      : undefined;
  },

  // Get session by OAuth state (for callback handling)
  getSessionByState: async (state) => {
    if (!state) return undefined;

    const [session] = await db
      .select()
      .from(McpOAuthSessionTable)
      .where(eq(McpOAuthSessionTable.state, state));

    return session
      ? (decryptMcpOAuthSecrets(session) as McpOAuthSession)
      : undefined;
  },

  // 2. Create/Update methods

  // Create new OAuth session
  createSession: async (mcpServerId, data) => {
    const now = new Date();

    const [session] = await db
      .insert(McpOAuthSessionTable)
      .values({
        ...(data as McpOAuthSession),
        // Encrypted credential fields must override the plaintext spread.
        ...encryptMcpOAuthSecrets(data),
        mcpServerId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return decryptMcpOAuthSecrets(session) as McpOAuthSession;
  },

  // Update existing session by state
  updateSessionByState: async (state, data) => {
    const now = new Date();

    const [session] = await db
      .update(McpOAuthSessionTable)
      .set({
        ...encryptMcpOAuthSecrets(data),
        updatedAt: now,
      })
      .where(eq(McpOAuthSessionTable.state, state))
      .returning();

    if (!session) {
      throw new Error(`Session with state ${state} not found`);
    }

    return decryptMcpOAuthSecrets(session) as McpOAuthSession;
  },

  saveTokensAndCleanup: async (state, mcpServerId, data) => {
    const [session] = await db
      .update(McpOAuthSessionTable)
      .set({
        ...encryptMcpOAuthSecrets(data),
        updatedAt: new Date(),
      })
      .where(eq(McpOAuthSessionTable.state, state))
      .returning();

    await db
      .delete(McpOAuthSessionTable)
      .where(
        and(
          eq(McpOAuthSessionTable.mcpServerId, mcpServerId),
          isNull(McpOAuthSessionTable.tokens),
          ne(McpOAuthSessionTable.state, state),
        ),
      );

    return decryptMcpOAuthSecrets(session) as McpOAuthSession;
  },

  // Delete a session by its OAuth state
  deleteByState: async (state) => {
    await db
      .delete(McpOAuthSessionTable)
      .where(eq(McpOAuthSessionTable.state, state));
  },
};
