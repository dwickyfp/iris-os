import type { AllowedMCPServer } from "app-types/mcp";

export type AuthorizedMcpServers = Record<string, AllowedMCPServer>;

/**
 * Server-owned intersection of the client-supplied MCP allowlist with the
 * servers the user actually owns (or that are public). The allowlist on its
 * own is never authoritative: a server id the user cannot access is dropped.
 */
export function selectAccessibleMcpServers(
  authorized: AuthorizedMcpServers | undefined,
  accessibleServerIds: ReadonlySet<string>,
): AuthorizedMcpServers {
  const allowed: AuthorizedMcpServers = {};
  for (const [serverId, value] of Object.entries(authorized ?? {})) {
    if (!accessibleServerIds.has(serverId)) continue;
    allowed[serverId] = { tools: [...value.tools] };
  }
  return allowed;
}

/** Drops tools whose server id is outside the accessible set. */
export function filterToolsByAccessibleServers<
  T extends { _mcpServerId: string },
>(
  tools: Record<string, T>,
  accessibleServerIds: ReadonlySet<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(tools).filter(([, tool]) =>
      accessibleServerIds.has(tool._mcpServerId),
    ),
  );
}

/**
 * Resolves the set of MCP server ids a user may bind tools from. The loader
 * is injected so the ownership source of truth (repository) stays explicit.
 */
export async function accessibleMcpServerIdsForUser(
  userId: string,
  load: (userId: string) => Promise<{ id: string }[]>,
): Promise<Set<string>> {
  const servers = await load(userId);
  return new Set(servers.map((server) => server.id));
}
