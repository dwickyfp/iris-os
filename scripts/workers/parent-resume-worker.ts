import type { Tool } from "ai";
import { recordActivityEvent } from "lib/activity/service";
import { createToolLoopAgent } from "lib/ai/agent/create-tool-loop-agent";
import {
  createAgentRuntimeContext,
  createBaseAgentRuntimeContext,
} from "lib/ai/agent/runtime-context";
import type {
  ApprovalPolicy,
  RuntimeToolMode,
} from "lib/ai/agent/runtime-context";
import { createGoalVerificationRequirement } from "lib/ai/artifacts/default-verification.server";
import { enqueueMemoryReview } from "lib/ai/memory/queue";
import { indexChatMessage } from "lib/ai/memory/service";
import { customModelProvider } from "lib/ai/models";
import {
  type ParentResumeGeneration,
  createParentResumeExecutor,
  resolveParentResumeAuthorization,
} from "lib/ai/runs/parent-resume-executor";
import {
  PARENT_RESUME_QUEUE,
  PARENT_RESUME_SWEEP_QUEUE,
  enqueueParentResume,
} from "lib/ai/runs/parent-resume-queue";
import { runManager } from "lib/ai/runs/server";
import type { ClaimedParentRun } from "lib/ai/runs/types";
import type { ResolvedPolicySnapshot } from "lib/ai/runtime";
import { resolveServerCapabilities } from "lib/ai/runtime/capabilities/server";
import type { RunPreparationSnapshot } from "lib/ai/runtime/run-preparer";
import { irisHarness } from "lib/ai/runtime/server";
import { createProductionRunAdapter } from "lib/ai/runtime/server-run-adapters";
import { createSkillsRuntime } from "lib/ai/skill";
import { createDelegateWorkTool } from "lib/ai/tools/delegation/delegate-work";
import {
  agentRepository,
  chatRepository,
  remoteAgentRepository,
  skillRepository,
} from "lib/db/repository";
import type { DelegationTarget } from "lib/delegation/targets";
import { generateUUID } from "lib/utils";
import type PgBoss from "pg-boss";
import { workflowToVercelAITool } from "../../src/app/api/chat/shared.chat";

type Recipe = {
  userId: string;
  userMessageId?: string;
  threadId: string;
  workspaceId?: string;
  taskId?: string;
  agentId?: string;
  instructions?: string;
  descriptorIds?: string[];
  eligibleDelegationTargets?: string[];
  allowedMcpServers?: Record<string, { tools: string[] }>;
  allowedAppDefaultToolkit?: string[];
  toolChoice: RuntimeToolMode;
  autonomy: "standard" | "ask" | "off";
  resolvedPolicy: ResolvedPolicySnapshot;
  routingSnapshot?: RunPreparationSnapshot["routing"];
  budgetSnapshot?: RunPreparationSnapshot["budget"];
  completionSnapshot?: RunPreparationSnapshot["completion"];
  contextSnapshot?: RunPreparationSnapshot["context"];
  modelSnapshot?: RunPreparationSnapshot["model"];
  driverSnapshot?: RunPreparationSnapshot["driver"];
};

async function currentDelegationTargets(
  recipe: Recipe,
  descriptorIds: Set<string>,
) {
  const persistedTargets = new Set(recipe.eligibleDelegationTargets ?? []);
  const [agents, remotes] = await Promise.all([
    agentRepository.selectAgentsByUserId(recipe.userId),
    remoteAgentRepository.listByUserId(recipe.userId),
  ]);
  return [
    ...agents.flatMap((agent): DelegationTarget[] => {
      const id = `local:${agent.id}`;
      return agent.id !== recipe.agentId &&
        persistedTargets.has(id) &&
        descriptorIds.has(`local-peer:${agent.id}`)
        ? [{ kind: "local", agentId: agent.id, name: agent.name }]
        : [];
    }),
    ...remotes.flatMap((agent): DelegationTarget[] => {
      const id = `remote:${agent.id}`;
      return agent.status === "active" &&
        persistedTargets.has(id) &&
        descriptorIds.has(`remote-peer:${agent.id}`)
        ? [{ kind: "remote", connectionId: agent.id, name: agent.name }]
        : [];
    }),
  ];
}

async function resolveRuntime(
  claimed: ClaimedParentRun,
  joinedMessages: Parameters<
    ReturnType<typeof createToolLoopAgent>["generate"]
  >[0]["messages"],
) {
  const recipe = claimed.checkpoint.authorizationRecipe as Recipe;
  const modelRef = claimed.checkpoint.modelConfig as {
    provider?: string;
    model?: string;
  };
  if (!modelRef.provider || !modelRef.model)
    throw new Error("PARENT_RESUME_MODEL_REQUIRED");
  const persistedModel = (recipe.modelSnapshot ?? modelRef) as {
    provider?: string;
    model?: string;
  };
  if (
    persistedModel.provider !== modelRef.provider ||
    persistedModel.model !== modelRef.model
  )
    throw new Error("PARENT_RESUME_MODEL_SNAPSHOT_MISMATCH");
  const configured = await customModelProvider.getModelConfiguration({
    provider: modelRef.provider,
    model: modelRef.model,
  });
  if (
    configured.provider !== modelRef.provider ||
    configured.model !== modelRef.model
  )
    throw new Error("PARENT_RESUME_MODEL_UNAVAILABLE");
  const descriptorIds = new Set(recipe.descriptorIds ?? []);
  const { resolvedPolicy, toolChoice } =
    resolveParentResumeAuthorization(recipe);
  const targets = await currentDelegationTargets(recipe, descriptorIds);
  const capabilities = await resolveServerCapabilities({
    context: {
      userId: recipe.userId,
      primaryAgentId: recipe.agentId,
      allowedMcpServers: recipe.allowedMcpServers,
      allowedAppDefaultToolkit: recipe.allowedAppDefaultToolkit,
      toolsEnabled: true,
      workflowsEnabled: true,
      delegationEnabled: false,
      remoteAgentsEnabled: false,
    },
    hints: { mode: "prefer", requested: [] },
    skillsRuntime: await createSkillsRuntime({
      repository: skillRepository,
      agentId: recipe.agentId,
      userId: recipe.userId,
    }),
    workflowTool: (workflow) =>
      workflowToVercelAITool({
        ...workflow,
        dataStream: { write() {} } as any,
      }),
    createDelegationTool: () => {
      throw new Error("UNEXPECTED_DELEGATION_CAPABILITY");
    },
  });
  const tools = Object.fromEntries(
    capabilities.ordered
      .filter(
        ({ id, key }) =>
          descriptorIds.has(id) && Object.hasOwn(capabilities.model, key),
      )
      .map(({ key }) => [key, capabilities.model[key] as Tool]),
  );
  if (targets.length) {
    tools.delegate_agent = createDelegateWorkTool({
      parentRunId: claimed.run.id,
      userId: claimed.run.userId,
      targets,
    });
  }
  const agent = recipe.agentId
    ? await agentRepository.selectAgentById(recipe.agentId, recipe.userId)
    : null;
  if (recipe.agentId && !agent)
    throw new Error("PARENT_RESUME_AGENT_UNAVAILABLE");
  const preparationAdapter = createProductionRunAdapter(
    {
      surface: "resume",
      approvalPolicy: resolvedPolicy.approvalPolicy as ApprovalPolicy,
      persistedPolicy: resolvedPolicy,
    },
    {
      resolveCapabilities: async () => ({
        value: tools,
        tools,
        descriptors: Object.keys(tools).map(
          (key) =>
            resolvedPolicy.capabilities?.[key] ?? {
              id: `tool:${key}`,
              key,
            },
        ),
        selectedCapabilities: capabilities.ordered,
        routing: (recipe.routingSnapshot ?? {
          descriptorIds: [...descriptorIds],
          eligibleDelegationTargets: recipe.eligibleDelegationTargets ?? [],
        }) as Record<string, unknown>,
      }),
      resolveRuntimeContext: async ({ policy }) =>
        agent
          ? createAgentRuntimeContext({
              requestId: generateUUID(),
              runId: claimed.run.id,
              userId: recipe.userId,
              workspaceId: recipe.workspaceId,
              taskId: recipe.taskId,
              threadId: recipe.threadId,
              agent,
              toolMode: toolChoice,
              approvalPolicy: policy.approvalPolicy as ApprovalPolicy,
            })
          : createBaseAgentRuntimeContext({
              requestId: generateUUID(),
              runId: claimed.run.id,
              userId: recipe.userId,
              workspaceId: recipe.workspaceId,
              taskId: recipe.taskId,
              threadId: recipe.threadId,
              toolMode: toolChoice,
              approvalPolicy: policy.approvalPolicy as ApprovalPolicy,
            }),
      resolveModel: async () => ({
        value: await customModelProvider.getModel({
          provider: modelRef.provider!,
          model: modelRef.model!,
        }),
        descriptor: recipe.modelSnapshot ?? modelRef,
      }),
    },
  );
  const preparationCapabilities =
    await preparationAdapter.resolveCapabilities(undefined);
  const preparedTools = preparationCapabilities.tools as Record<string, Tool>;
  preparationCapabilities.value = preparedTools;
  const prepared = await preparationAdapter.prepare({
    capabilities: preparationCapabilities,
    request: {
      runId: claimed.run.id,
      userId: recipe.userId,
      workspaceId: recipe.workspaceId,
      taskId: recipe.taskId,
      agentId: recipe.agentId,
      instructions: recipe.instructions ?? "Continue the task.",
      sources: [
        ...currentGenerationObservations(claimed).map((observation, index) => ({
          id: `joined-observation-${index}`,
          kind: "remote_observation" as const,
          content: JSON.stringify(observation),
          trust: "untrusted" as const,
          priority: 100,
        })),
        ...(claimed.checkpoint.verificationFeedback
          ? [
              {
                id: `goal-verification-${claimed.checkpoint.goalRound ?? 1}`,
                kind: "continuation" as const,
                content: JSON.stringify({
                  kind: "goal_verification_feedback",
                  round: claimed.checkpoint.goalRound ?? 1,
                  feedback: claimed.checkpoint.verificationFeedback,
                }),
                trust: "mixed" as const,
                priority: 110,
              },
            ]
          : []),
      ],
      restore: {
        routing: recipe.routingSnapshot,
        budget: recipe.budgetSnapshot,
        completion: recipe.completionSnapshot,
        context: recipe.contextSnapshot,
        model: recipe.modelSnapshot,
        driver: recipe.driverSnapshot,
      },
      goal: claimed.run.goalRequirement?.goal,
    },
  });
  const runtimeContext = prepared.runtimeContext!;
  const agentConfig = {
    profile: agent ? { type: "custom", agent } : { type: "base" },
    model: prepared.model!,
    instructions: prepared.instructions,
    tools: preparedTools,
    runtimeContext,
    resolvedPolicy: prepared.policy!,
  } as Parameters<typeof irisHarness.generateClaimed>[0]["agent"];
  return {
    preparationSnapshot: prepared.snapshot,
    async generate(
      messages: Parameters<
        ReturnType<typeof createToolLoopAgent>["generate"]
      >[0]["messages"],
    ) {
      const lifecycle = await irisHarness.generateClaimed({
        agent: agentConfig,
        execution: {
          messages: messages ?? joinedMessages,
          toolsContext: runtimeContext,
          timeout: Math.max(
            1,
            (claimed.run.absoluteDeadlineAt?.getTime() ?? Date.now() + 30_000) -
              Date.now(),
          ),
        } as any,
        orchestration: {
          identity: {
            userId: claimed.run.userId,
            runId: claimed.run.id,
            requestId: runtimeContext.requestId,
            actorType: agent ? "agent" : "system",
            actorId: agent?.id,
            agentId: agent?.id,
            workspaceId: claimed.run.workspaceId ?? undefined,
            taskId: claimed.run.taskId ?? undefined,
            threadId: recipe.threadId,
          },
          run: { mode: "claimed", claimToken: claimed.token },
          policy: prepared.policy,
          completionRequirement: claimed.run.goalRequirement
            ? createGoalVerificationRequirement(claimed.run.goalRequirement)
            : undefined,
          context: prepared.context,
          budget: prepared.budget,
          routing: {
            descriptorIds:
              (prepared.snapshot.routing as { descriptorIds?: string[] })
                ?.descriptorIds ??
              (prepared.snapshot.routing as { selectedIds?: string[] })
                ?.selectedIds,
            diagnostics: (
              prepared.snapshot.routing as {
                diagnostics?: Record<string, unknown>;
              }
            )?.diagnostics,
            model: prepared.snapshot.model as Record<string, unknown>,
            driver: prepared.snapshot.driver as Record<string, unknown>,
          },
        },
      });
      const result = lifecycle.native;
      return {
        text: result.text,
        responseMessages: result.responseMessages,
        usage: result.usage,
        signal: lifecycle.signal,
        assertActive: lifecycle.assertActive,
        fail: lifecycle.fail,
        finalize: (result, value, checkpoint) =>
          lifecycle.finalize(
            result,
            value,
            checkpoint ? { checkpoint } : undefined,
          ),
        checkpoint: lifecycle.waitForExternal,
      } as ParentResumeGeneration;
    },
  };
}

function currentGenerationObservations(claimed: ClaimedParentRun) {
  return claimed.joins
    .filter(
      (join) => join.checkpointGeneration === claimed.checkpoint.generation,
    )
    .map((join) => join.observation);
}

const execute = createParentResumeExecutor({
  claim: (parentRunId) => runManager.claimParentResume(parentRunId, 120_000),
  resolve: resolveRuntime,
  saveAssistant: async ({ threadId, messageId, parts, modelConfig }) => {
    await chatRepository.upsertMessage({
      threadId,
      id: messageId,
      role: "assistant",
      parts,
      metadata: {
        chatModel: modelConfig as { provider: string; model: string },
      },
    });
  },
  complete: async ({ claimed, threadId, messageId, parts }) => {
    const recipe = claimed.checkpoint.authorizationRecipe as Recipe;
    await indexChatMessage({
      userId: claimed.run.userId,
      threadId,
      message: { id: messageId, role: "assistant", parts },
    });
    if (recipe.userMessageId)
      void enqueueMemoryReview({
        id: `${threadId}:${messageId}`,
        userId: claimed.run.userId,
        threadId,
        workspaceId: claimed.run.workspaceId ?? undefined,
        taskId: claimed.run.taskId ?? undefined,
        assistantMessageId: messageId,
        userMessageId: recipe.userMessageId,
        agentId: claimed.run.agentId ?? undefined,
      });
    void recordActivityEvent(claimed.run.userId, {
      actorType: claimed.run.agentId ? "agent" : "system",
      actorId: claimed.run.agentId ?? undefined,
      scopeType: claimed.run.taskId
        ? "task"
        : claimed.run.workspaceId
          ? "workspace"
          : claimed.run.agentId
            ? "agent"
            : "global",
      scopeId:
        claimed.run.taskId ??
        claimed.run.workspaceId ??
        claimed.run.agentId ??
        null,
      eventType: "chat.completed",
      subjectType: "thread",
      subjectId: threadId,
      payload: { assistantMessageId: messageId },
      runId: claimed.run.id,
      threadId,
      taskId: claimed.run.taskId ?? undefined,
      agentId: claimed.run.agentId ?? undefined,
      idempotencyKey: `chat.completed:${messageId}`,
    });
  },
  fail: async () => undefined,
});

export async function registerParentResumeWorkers(boss: PgBoss) {
  await boss.createQueue(PARENT_RESUME_QUEUE);
  await boss.createQueue(PARENT_RESUME_SWEEP_QUEUE);
  await boss.work<{ parentRunId: string }>(
    PARENT_RESUME_QUEUE,
    async (jobs) => {
      await Promise.all(jobs.map((job) => execute(job.data.parentRunId)));
    },
  );
  await boss.work(PARENT_RESUME_SWEEP_QUEUE, async () => {
    const pending = await runManager.listPendingParentResumeIds(100);
    for (const parentRunId of pending) {
      if (await enqueueParentResume(parentRunId))
        await runManager.markParentResumeDispatched(parentRunId);
    }
  });
  await boss.schedule(PARENT_RESUME_SWEEP_QUEUE, "*/1 * * * *", {});
}
