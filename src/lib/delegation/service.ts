import "server-only";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { sanitizeActivityPayload } from "lib/activity/sanitize";
import { recordActivityEvent } from "lib/activity/service";
import { intersectDelegationAuthority } from "lib/ai/agent/delegation-policy";
import { runManager } from "lib/ai/runs/server";
import type { RunBudget } from "lib/ai/runtime/budget";
import {
  type PolicyAuthority,
  policyEngine,
} from "lib/ai/runtime/policy-engine";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunTable,
  AgentTable,
  DelegationRunTable,
} from "lib/db/pg/schema.pg";
import { remoteAgentRepository, skillRepository } from "lib/db/repository";
import { assertDelegationTargetEligible } from "lib/delegation/targets";
import { isV2FeatureEnabled } from "lib/feature-flags";
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
  childAgentId?: string;
  agentRef?:
    | { kind: "local"; agentId: string }
    | { kind: "remote"; connectionId: string };
  objective: string;
  context?: Record<string, unknown>;
  timeoutMs?: number;
  tokenBudget?: number;
  idempotencyKey?: string;
  toolCallId: string;
}) {
  const [parent] = await pgDb
    .select()
    .from(AgentRunTable)
    .where(
      and(
        eq(AgentRunTable.id, input.parentRunId),
        eq(AgentRunTable.userId, input.userId),
        eq(AgentRunTable.status, "running"),
        sql`${AgentRunTable.cancelRequestedAt} IS NULL`,
      ),
    );
  if (!parent) throw new Error("PARENT_RUN_NOT_FOUND");
  if (parent.depth >= DELEGATION_LIMITS.maxDepth)
    throw new Error("DELEGATION_DEPTH_EXCEEDED");
  const target =
    input.agentRef ??
    (input.childAgentId
      ? ({ kind: "local", agentId: input.childAgentId } as const)
      : null);
  if (!target) throw new Error("CHILD_AGENT_NOT_FOUND");
  assertDelegationTargetEligible({
    context: parent.context,
    target,
    remoteAgentsEnabled: isV2FeatureEnabled("remoteAgents"),
  });
  const childAgent =
    target.kind === "local"
      ? (
          await pgDb
            .select({ id: AgentTable.id })
            .from(AgentTable)
            .where(
              and(
                eq(AgentTable.id, target.agentId),
                eq(AgentTable.userId, input.userId),
              ),
            )
        )[0]
      : null;
  const remoteAgent =
    target.kind === "remote"
      ? await remoteAgentRepository.selectById(
          target.connectionId,
          input.userId,
        )
      : null;
  if (target.kind === "local" && !childAgent)
    throw new Error("CHILD_AGENT_NOT_FOUND");
  if (
    target.kind === "remote" &&
    (!remoteAgent || remoteAgent.status !== "active")
  )
    throw new Error("REMOTE_AGENT_NOT_FOUND");
  const childSkills = childAgent
    ? await skillRepository.selectSkillsByAgentId(childAgent.id, input.userId)
    : [];
  const childTools = childSkills.flatMap((skill) => skill.allowedTools ?? []);
  const approvedTools = Array.isArray(parent.context.approvedDelegationTools)
    ? parent.context.approvedDelegationTools.filter(
        (tool): tool is string => typeof tool === "string",
      )
    : [];
  const parentPolicy =
    parent.context.policyAuthority &&
    typeof parent.context.policyAuthority === "object"
      ? (parent.context.policyAuthority as PolicyAuthority)
      : {};
  const authority = intersectDelegationAuthority({
    parentTools: parent.allowedTools,
    childTools,
    approvedTools,
    parentPolicy,
    childPolicy: {
      destinationKinds: [target.kind === "remote" ? "remote" : "local"],
    },
  });
  const allowedTools = authority.allowedTools;
  const delegationDecision = policyEngine.evaluate({
    actor: {
      type: "agent",
      id: parent.agentId ?? undefined,
      userId: input.userId,
    },
    capability: {
      id:
        target.kind === "remote"
          ? `remote-peer:${target.connectionId}`
          : `local-peer:${target.agentId}`,
      key: "delegate_agent",
      risks: target.kind === "remote" ? ["write", "remote"] : ["write"],
    },
    action: "delegate",
    resource: target.kind === "remote" ? target.connectionId : target.agentId,
    args: input.context ?? {},
    destination: {
      kind: target.kind === "remote" ? "remote" : "local",
      id: target.kind === "remote" ? target.connectionId : target.agentId,
    },
    runtime: {
      kind: target.kind === "remote" ? "remote_delegation" : "local_delegation",
      approvalPolicy:
        parent.context.approvalPolicy === "always" ||
        parent.context.approvalPolicy === "never"
          ? parent.context.approvalPolicy
          : "destructive_only",
      runId: parent.id,
      parentRunId: parent.parentRunId ?? undefined,
    },
  });
  if (delegationDecision.result === "deny")
    throw new Error("DELEGATION_DENIED");
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
  const childBudget: RunBudget = {
    maxTokens: tokenBudget,
    maxDurationMs: timeoutMs,
    maxDepth: DELEGATION_LIMITS.maxDepth,
  };
  const idempotencyKey =
    input.idempotencyKey ??
    createHash("sha256")
      .update(
        JSON.stringify({
          parentRunId: parent.id,
          target,
          objective: input.objective,
          context: sanitizeActivityPayload(input.context ?? {}),
        }),
      )
      .digest("hex");
  const run = await runManager.queueDelegated({
    id: childRunId,
    delegationId,
    userId: input.userId,
    agentId: childAgent?.id,
    target,
    parentRunId: parent.id,
    workspaceId: parent.workspaceId ?? undefined,
    taskId: parent.taskId ?? undefined,
    objective: input.objective.slice(0, 8_000),
    context: {
      ...(sanitizeActivityPayload(input.context ?? {}) as Record<
        string,
        unknown
      >),
      objective: input.objective.slice(0, 8_000),
      policyAuthority: authority.policy,
      delegationPolicyDecision: delegationDecision,
    },
    allowedTools,
    timeoutMs,
    depth: parent.depth + 1,
    tokenBudget,
    budget: childBudget,
    idempotencyKey,
    toolCallId: input.toolCallId,
  });
  await recordActivityEvent(input.userId, {
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
    subjectId: run.id,
    runId: run.id,
    parentRunId: parent.id,
    taskId: parent.taskId ?? undefined,
    agentId: childAgent?.id,
    payload: {
      targetType: target.kind === "remote" ? "remote_agent" : "agent",
      policyDecisionId: delegationDecision.decisionId,
      policyResult: delegationDecision.result,
      policyRisks: delegationDecision.risks,
    },
    idempotencyKey: `delegation.child_queued:${run.id}`,
  });
  if (await enqueueDelegatedRun(run.id))
    await runManager.markDispatched(run.id);
  const [persistedDelegation] = await pgDb
    .select({ id: DelegationRunTable.id })
    .from(DelegationRunTable)
    .where(eq(DelegationRunTable.childRunId, run.id));
  return {
    id: persistedDelegation?.id ?? delegationId,
    childRunId: run.id,
    status: "queued" as const,
    allowedTools,
    policyDecision: delegationDecision,
    policyAuthority: authority.policy,
  };
}

export async function activeChildCount(parentRunId: string) {
  return runManager.countRunningChildren(parentRunId);
}
