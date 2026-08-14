import "server-only";

import { and, count, eq, inArray } from "drizzle-orm";
import {
  insertActivityEvent,
  publishActivityEvent,
} from "lib/activity/service";
import { sanitizeActivityPayload } from "lib/activity/sanitize";
import { intersectDelegationPermissions } from "lib/ai/agent/delegation-policy";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunTable,
  AgentTable,
  DelegationRunTable,
} from "lib/db/pg/schema.pg";
import { skillRepository } from "lib/db/repository";
import { generateUUID } from "lib/utils";
import { enqueueDelegatedRun } from "./queue";

export const DELEGATION_LIMITS = {
  maxDepth: 3,
  maxChildren: 8,
  maxParallelChildren: 3,
  defaultTimeoutMs: 300_000,
  maxTimeoutMs: 3_600_000,
  defaultTokenBudget: 50_000,
} as const;

export async function createDelegatedRun(input: {
  userId: string;
  parentRunId: string;
  childAgentId: string;
  objective: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
  tokenBudget?: number;
}) {
  const [parent] = await pgDb
    .select()
    .from(AgentRunTable)
    .where(
      and(
        eq(AgentRunTable.id, input.parentRunId),
        eq(AgentRunTable.userId, input.userId),
        eq(AgentRunTable.status, "running"),
      ),
    );
  if (!parent) throw new Error("PARENT_RUN_NOT_FOUND");
  if (parent.depth >= DELEGATION_LIMITS.maxDepth)
    throw new Error("DELEGATION_DEPTH_EXCEEDED");
  const [childAgent] = await pgDb
    .select({ id: AgentTable.id })
    .from(AgentTable)
    .where(
      and(
        eq(AgentTable.id, input.childAgentId),
        eq(AgentTable.userId, input.userId),
      ),
    );
  if (!childAgent) throw new Error("CHILD_AGENT_NOT_FOUND");
  const [{ total }] = await pgDb
    .select({ total: count() })
    .from(AgentRunTable)
    .where(eq(AgentRunTable.parentRunId, parent.id));
  if (total >= DELEGATION_LIMITS.maxChildren)
    throw new Error("DELEGATION_CHILD_LIMIT_EXCEEDED");

  const childSkills = await skillRepository.selectSkillsByAgentId(
    childAgent.id,
    input.userId,
  );
  const childTools = childSkills.flatMap((skill) => skill.allowedTools ?? []);
  const approvedTools = Array.isArray(parent.context.approvedDelegationTools)
    ? parent.context.approvedDelegationTools.filter(
        (tool): tool is string => typeof tool === "string",
      )
    : [];
  const allowedTools = intersectDelegationPermissions({
    parentTools: parent.allowedTools,
    childTools,
    approvedTools,
  });
  const childRunId = generateUUID();
  const delegationId = generateUUID();
  const timeoutMs = Math.min(
    DELEGATION_LIMITS.maxTimeoutMs,
    Math.max(1_000, input.timeoutMs ?? DELEGATION_LIMITS.defaultTimeoutMs),
  );
  const tokenBudget = Math.min(
    200_000,
    Math.max(1_000, input.tokenBudget ?? DELEGATION_LIMITS.defaultTokenBudget),
  );
  const event = await pgDb.transaction(async (tx) => {
    await tx.insert(AgentRunTable).values({
      id: childRunId,
      userId: input.userId,
      agentId: childAgent.id,
      parentRunId: parent.id,
      workspaceId: parent.workspaceId,
      taskId: parent.taskId,
      status: "queued",
      context: {
        ...(sanitizeActivityPayload(input.context ?? {}) as Record<
          string,
          unknown
        >),
        objective: input.objective.slice(0, 8_000),
      },
      allowedTools,
      timeoutMs,
      depth: parent.depth + 1,
      tokenBudget,
    });
    await tx.insert(DelegationRunTable).values({
      id: delegationId,
      parentRunId: parent.id,
      childRunId,
      userId: input.userId,
      objective: input.objective.slice(0, 8_000),
    });
    return insertActivityEvent(tx, input.userId, {
      actorType: "agent",
      actorId: parent.agentId ?? undefined,
      scopeType: parent.taskId
        ? "task"
        : parent.workspaceId
          ? "workspace"
          : parent.agentId
            ? "agent"
            : "global",
      scopeId: parent.taskId ?? parent.workspaceId ?? parent.agentId,
      eventType: "delegation.child_queued",
      subjectType: "agent_run",
      subjectId: childRunId,
      runId: childRunId,
      parentRunId: parent.id,
      taskId: parent.taskId ?? undefined,
      agentId: childAgent.id,
      payload: { targetType: "agent" },
      idempotencyKey: `delegation.child_queued:${childRunId}`,
    });
  });
  publishActivityEvent(event.id);
  await enqueueDelegatedRun(childRunId);
  return {
    id: delegationId,
    childRunId,
    status: "queued" as const,
    allowedTools,
  };
}

export async function activeChildCount(parentRunId: string) {
  const [{ total }] = await pgDb
    .select({ total: count() })
    .from(AgentRunTable)
    .where(
      and(
        eq(AgentRunTable.parentRunId, parentRunId),
        inArray(AgentRunTable.status, ["running"]),
      ),
    );
  return total;
}
