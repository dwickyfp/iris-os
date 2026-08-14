import type { MemoryScope, MemoryScopeType } from "app-types/memory";

export type MemoryScopeOwnership = Record<
  Exclude<MemoryScopeType, "global">,
  (userId: string, scopeId: string) => Promise<boolean>
>;

export function memoryScopeKey(scope: MemoryScope) {
  return `${scope.scopeType}:${scope.scopeId ?? ""}`;
}

export function buildRecallScopes(context: {
  taskId?: string;
  agentId?: string;
  workspaceId?: string;
}): MemoryScope[] {
  const scopes: MemoryScope[] = [];
  if (context.taskId)
    scopes.push({ scopeType: "task", scopeId: context.taskId });
  if (context.agentId)
    scopes.push({ scopeType: "agent", scopeId: context.agentId });
  if (context.workspaceId)
    scopes.push({ scopeType: "workspace", scopeId: context.workspaceId });
  scopes.push({ scopeType: "global", scopeId: null });
  return scopes;
}

export async function resolveMemoryScope(
  userId: string,
  input: { scopeType?: MemoryScopeType; scopeId?: string | null },
  ownership: MemoryScopeOwnership,
): Promise<MemoryScope> {
  const scopeType = input.scopeType ?? "global";
  const scopeId = input.scopeId ?? null;
  if (scopeType === "global") {
    if (scopeId) throw new Error("Global memory cannot have a scopeId");
    return { scopeType, scopeId: null };
  }
  if (!scopeId) throw new Error(`${scopeType} memory requires a scopeId`);
  if (!(await ownership[scopeType](userId, scopeId))) {
    throw new Error("Memory scope not found");
  }
  return { scopeType, scopeId };
}
