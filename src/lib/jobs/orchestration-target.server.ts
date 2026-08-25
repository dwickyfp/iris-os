import "server-only";

import type { Tool } from "ai";
import { isTerminalAgentRunStatus } from "lib/ai/runs/status";
import { eq } from "drizzle-orm";
import { createBaseAgentRuntimeContext } from "lib/ai/agent/runtime-context";
import {
  buildServerCapabilityResolutionInput,
  resolveServerCapabilities,
} from "lib/ai/runtime/capabilities/server";
import { createCapabilityInvoker } from "lib/ai/runtime/capability-invoker";
import type { ResolvedPolicySnapshot } from "lib/ai/runtime/contracts";
import { executeCapabilityOrchestrationPlan } from "lib/ai/runtime/orchestration-plan";
import { projectCapabilityResultSurface } from "lib/ai/runtime/result-surface.server";
import { serverBudgetAuthority } from "lib/ai/runtime/server-budget-authority";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable, RootRunGoalTable } from "lib/db/pg/schema.pg";
import type { DurableJobTargetHandler } from "./targets";

export const productionCapabilityOrchestrationTarget: DurableJobTargetHandler =
  async (job, context) => {
    const { signal } = context ?? {};
    if (!job.runInbox) throw new Error("DURABLE_JOB_RUN_REQUIRED");
    const [run] = await pgDb
      .select()
      .from(AgentRunTable)
      .where(eq(AgentRunTable.id, job.runInbox.runId));
    if (!run) throw new Error("DURABLE_JOB_RUN_NOT_FOUND");
    if (
      isTerminalAgentRunStatus(run.status) ||
      run.cancelRequestedAt ||
      (run.status === "waiting_input" || run.status === "waiting_approval")
    )
      throw new Error("DURABLE_JOB_RUN_NOT_EXECUTABLE");
    const persistedIds = new Set(
      Array.isArray(run.context.capabilityDescriptorIds)
        ? (run.context.capabilityDescriptorIds as string[])
        : [],
    );
    const capabilityInput = await buildServerCapabilityResolutionInput({
      userId: run.userId,
      workspaceId: run.workspaceId ?? undefined,
      taskId: run.taskId ?? undefined,
      runId: run.id,
      goal: run.goalRequirement?.goal ?? "Execute the authorized orchestration",
      featureState: {
        tools: true,
        workflows: false,
        delegation: false,
        remoteAgents: false,
        learning: false,
      },
    });
    const capabilities = await resolveServerCapabilities(capabilityInput);
    const descriptors = new Map(
      capabilities.ordered
        .filter(
          (descriptor) =>
            persistedIds.has(descriptor.id) &&
            run.allowedTools.includes(descriptor.key) &&
            typeof (descriptor.value as Tool | undefined)?.execute === "function",
        )
        .map((descriptor) => [descriptor.id, descriptor]),
    );
    const runtimeContext = createBaseAgentRuntimeContext({
      requestId: job.id,
      runId: run.id,
      userId: run.userId,
      workspaceId: run.workspaceId ?? undefined,
      taskId: run.taskId ?? undefined,
      toolMode: "auto",
      approvalPolicy: persistedPolicySnapshot(run.context.resolvedPolicy)
        .approvalPolicy,
    });
    const resolvedPolicy = persistedPolicySnapshot(run.context.resolvedPolicy);
    const invoke = createCapabilityInvoker({
      runtimeContext,
      resolvedPolicy,
      maxParallel: 4,
      durableBudget: {
        charge: (token, kind, amount) =>
          serverBudgetAuthority.charge(
            run.id,
            `${run.id}:${job.id}:${token}`,
            kind,
            amount,
          ),
      },
      projectResult: projectCapabilityResultSurface,
    });
    const assertCurrentRevision = async () => {
      const [goal] = await pgDb
        .select({ revision: RootRunGoalTable.revision })
        .from(RootRunGoalTable)
        .where(eq(RootRunGoalTable.rootRunId, run.rootRunId));
      if (goal && goal.revision !== run.goalRevision)
        throw new Error("STALE_GOAL_REVISION");
    };
    const assertExecutable = async () => {
      if (run.cancelRequestedAt) throw new Error("DURABLE_JOB_RUN_CANCELLED");
      await assertCurrentRevision();
    };
    const result = await executeCapabilityOrchestrationPlan(
      job.payload,
      async ({ capabilityId, input }) => {
        signal?.throwIfAborted();
        await assertCurrentRevision();
        const descriptor = descriptors.get(capabilityId);
        if (!descriptor) throw new Error("CAPABILITY_NOT_AUTHORIZED");
        const tool = descriptor.value as Tool;
        const outcome = await invoke({
          capabilityId: descriptor.key,
          args: input,
          signal,
          concurrency: descriptor.risks?.includes("write")
            ? "exclusive"
            : "parallel",
          execute: (signal) =>
            tool.execute!(input, {
              toolCallId: `${job.id}:${capabilityId}`,
              messages: [],
              abortSignal: signal,
            } as never),
        });
        if (outcome.status !== "completed")
          throw new Error("CAPABILITY_APPROVAL_REQUIRED");
        signal?.throwIfAborted();
        await assertExecutable();
        return outcome.value;
      },
    );
    return { status: "completed", result };
  };

function persistedPolicySnapshot(
  value: unknown,
): ResolvedPolicySnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    !["always", "destructive_only", "never"].includes(
      (value as ResolvedPolicySnapshot).approvalPolicy,
    ) ||
    typeof (value as ResolvedPolicySnapshot).tools !== "object"
  ) {
    throw new Error("DURABLE_JOB_POLICY_SNAPSHOT_REQUIRED");
  }
  return value as ResolvedPolicySnapshot;
}
