import "server-only";

import { and, eq } from "drizzle-orm";
import { MemoryScopeTypeSchema, type MemoryScopeType } from "app-types/memory";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentTable } from "lib/db/pg/schema.pg";
import { taskRepository, workspaceRepository } from "lib/db/repository";
import { resolveMemoryScope } from "./scope";

export function resolveOwnedMemoryScope(
  userId: string,
  input: { scopeType?: MemoryScopeType; scopeId?: string | null },
) {
  return resolveMemoryScope(userId, input, {
    workspace: async (ownerId, scopeId) =>
      Boolean(await workspaceRepository.selectById(scopeId, ownerId)),
    agent: async (ownerId, scopeId) => {
      const [agent] = await pgDb
        .select({ id: AgentTable.id })
        .from(AgentTable)
        .where(and(eq(AgentTable.id, scopeId), eq(AgentTable.userId, ownerId)))
        .limit(1);
      return Boolean(agent);
    },
    task: async (ownerId, scopeId) =>
      Boolean(await taskRepository.select(scopeId, ownerId)),
  });
}

export function resolveMemoryScopeFromRequest(
  userId: string,
  request: Request,
) {
  const url = new URL(request.url);
  return resolveOwnedMemoryScope(userId, {
    scopeType: MemoryScopeTypeSchema.parse(
      url.searchParams.get("scopeType") ?? "global",
    ),
    scopeId: url.searchParams.get("scopeId"),
  });
}
