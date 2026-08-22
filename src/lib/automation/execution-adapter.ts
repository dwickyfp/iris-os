import "server-only";

import type { Tool } from "ai";
import type { Agent } from "app-types/agent";
import type { CapabilityHints } from "app-types/chat";
import {
  createAgentRuntimeContext,
  createBaseAgentRuntimeContext,
} from "lib/ai/agent/runtime-context";
import { createGoalVerificationRequirement } from "lib/ai/artifacts/default-verification.server";
import { customModelProvider } from "lib/ai/models";
import { runManager } from "lib/ai/runs/server";
import {
  type DriverGenerateInput,
  type HarnessOrchestration,
} from "lib/ai/runtime";
import { isBudgetExhausted } from "lib/ai/runtime/budget";
import {
  buildServerCapabilityResolutionInput,
  resolveServerCapabilities,
  subtractAutomationCapabilities,
} from "lib/ai/runtime/capabilities/server";
import { policyEngine } from "lib/ai/runtime/policy-engine";
import { irisHarness } from "lib/ai/runtime/server";
import { serverBudgetResolver } from "lib/ai/runtime/server-budget-resolver";
import { serverRunPreparer } from "lib/ai/runtime/server-run-preparer";
import { createWorkflowExecutor } from "lib/ai/workflow/executor/workflow-executor";
import {
  agentRepository,
  skillRepository,
  workflowRepository,
} from "lib/db/repository";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { sandboxManager, workflowSandboxServices } from "lib/sandbox/server";
import { generateUUID } from "lib/utils";

export type AutomationTarget = "workflow" | "skill" | "agent";

export type AutomationExecutionResult =
  | { status: "succeeded"; output: Record<string, unknown> }
  | {
      status: "failed";
      errorCode: string;
      message: string;
      retryable: boolean;
    }
  | { status: "cancelled"; message?: string }
  | { status: "timed_out"; message: string }
  | { status: "budget_exhausted"; message: string };

export function projectAutomationExecutionResult(
  result: AutomationExecutionResult,
) {
  const retryable =
    result.status === "timed_out" ||
    (result.status === "failed" && result.retryable);
  return {
    status: result.status,
    attemptStatus: result.status,
    retryable,
    error: result.status === "succeeded" ? null : result.message,
    errorCode:
      result.status === "failed"
        ? result.errorCode
        : result.status === "budget_exhausted"
          ? "BUDGET_EXHAUSTED"
          : null,
    output: result.status === "succeeded" ? result.output : null,
  };
}

type AutomationExecutionRequestBase = {
  runId: string;
  userId: string;
  workspaceId?: string;
  taskId?: string;
  capabilityHints?: CapabilityHints;
  allowedMcpServers?: Record<string, { tools: string[] }>;
  allowedAppDefaultToolkit?: string[];
  targetType: AutomationTarget;
  targetId: string;
  input: Record<string, unknown>;
  allowedTools?: string[];
  timeoutMs: number;
  signal: AbortSignal;
};

export type AutomationExecutionRequest = AutomationExecutionRequestBase &
  (
    | { executionSource: "automation" }
    | { executionSource: "delegation"; claimToken: string }
  );

type TargetExecutor = (
  request: AutomationExecutionRequest,
) => Promise<AutomationExecutionResult>;

export type AutomationExecutionDependencies = Record<
  AutomationTarget,
  TargetExecutor
>;

export type AutomationHarness = {
  generate(input: DriverGenerateInput): Promise<any>;
};

function objective(input: Record<string, unknown>) {
  const explicit = input.objective ?? input.prompt;
  return typeof explicit === "string" && explicit.trim()
    ? explicit.trim()
    : JSON.stringify(input);
}

type HeadlessDescriptor = {
  id: string;
  key: string;
  kind: string;
  risks?: readonly (
    | "read"
    | "write"
    | "destructive"
    | "network"
    | "code"
    | "remote"
  )[];
};

async function resolveHeadlessTools(input: {
  request: AutomationExecutionRequest;
  profile: { type: "base" } | { type: "custom"; agent: Agent };
  allowedTools?: string[];
  runId: string;
}): Promise<{
  tools: Record<string, Tool>;
  descriptors: HeadlessDescriptor[];
  snapshot: Record<string, unknown>;
}> {
  const agent =
    input.profile.type === "custom" ? input.profile.agent : undefined;
  const capabilities = await resolveServerCapabilities(
    await buildServerCapabilityResolutionInput({
      userId: input.request.userId,
      workspaceId: input.request.workspaceId,
      taskId: input.request.taskId,
      runId: input.runId,
      goal: objective(input.request.input),
      agent,
      hints: input.request.capabilityHints,
      permissions: {
        allowedMcpServers: input.request.allowedMcpServers,
        allowedAppDefaultToolkit: input.request.allowedAppDefaultToolkit,
      },
      featureState: {
        tools: true,
        workflows: true,
        delegation: isV2FeatureEnabled("delegation"),
        remoteAgents: isV2FeatureEnabled("remoteAgents"),
        learning: isV2FeatureEnabled("learning"),
      },
      workflowBinding: { signal: input.request.signal },
    }),
  );
  const explicitlyAllowed = new Set(input.allowedTools ?? []);
  const { descriptors, subtractions } = subtractAutomationCapabilities(
    capabilities.ordered,
    input.allowedTools,
  );
  const tools = Object.fromEntries(
    descriptors
      .filter(({ key }) => Object.hasOwn(capabilities.model, key))
      .map(({ key }) => [key, capabilities.model[key] as Tool]),
  );
  if (
    capabilities.model.delegate_agent &&
    (explicitlyAllowed.size === 0 || explicitlyAllowed.has("delegate_agent"))
  )
    tools.delegate_agent = capabilities.model.delegate_agent as Tool;
  return {
    tools,
    descriptors: descriptors as HeadlessDescriptor[],
    snapshot: {
      descriptorIds: descriptors.map(({ id }) => id),
      eligibleDelegationTargets: capabilities.eligibleDelegationTargets,
      diagnostics: capabilities.routing,
      subtractions,
    },
  };
}

export function mapWorkflowOutput(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== "object") return { output };
  const outputs = (output as { outputs?: unknown }).outputs;
  return outputs && typeof outputs === "object"
    ? (outputs as Record<string, unknown>)
    : { output };
}

export async function finishWorkflowAgentRun(
  runId: string,
  result: { isOk: boolean; output?: unknown; error?: unknown },
  manager: Pick<
    typeof runManager,
    "succeed" | "fail" | "exhaustBudget"
  > = runManager,
) {
  if (result.isOk)
    return manager.succeed(runId, mapWorkflowOutput(result.output));
  const message =
    result.error instanceof Error
      ? result.error.message.slice(0, 2_000)
      : String(result.error).slice(0, 2_000);
  return isBudgetExhausted(result.error)
    ? manager.exhaustBudget(runId, message)
    : manager.fail(runId, message, "WORKFLOW_FAILED");
}

export function classifyWorkflowFailure(
  error: unknown,
): Exclude<AutomationExecutionResult, { status: "succeeded" }> {
  const message =
    error instanceof Error
      ? error.message.slice(0, 2_000)
      : String(error).slice(0, 2_000);
  return isBudgetExhausted(error)
    ? { status: "budget_exhausted", message }
    : {
        status: "failed",
        errorCode: "WORKFLOW_FAILED",
        message,
        retryable: true,
      };
}

export async function runHeadlessAgent(input: {
  request: AutomationExecutionRequest;
  profile: { type: "base" } | { type: "custom"; agent: Agent };
  instructions: string;
  allowedTools?: string[];
  harness?: AutomationHarness;
  resolveBudget?: typeof serverBudgetResolver;
}) {
  const runId =
    input.request.executionSource === "delegation"
      ? input.request.runId
      : generateUUID();
  const engine =
    input.request.executionSource === "delegation"
      ? "delegation-runner"
      : "automation-runner";
  const resolved = await resolveHeadlessTools({ ...input, runId });
  const tools = resolved.tools;
  const prepared = await serverRunPreparer({
    resolveCapabilities: async () => ({
      value: tools,
      snapshot: resolved.snapshot,
    }),
    resolvePolicy: async () =>
      policyEngine.resolveSnapshot(
        Object.keys(tools),
        "never",
        resolved.descriptors.map(({ id, key, kind, risks }) => ({
          id,
          key,
          kind,
          risks,
        })),
      ),
    resolveRuntimeContext: async ({ policy }) => {
      const common = {
        requestId: generateUUID(),
        runId,
        userId: input.request.userId,
        workspaceId: input.request.workspaceId,
        toolMode: "auto" as const,
        approvalPolicy: policy?.approvalPolicy ?? "never",
      };
      return input.profile.type === "custom"
        ? createAgentRuntimeContext({ ...common, agent: input.profile.agent })
        : createBaseAgentRuntimeContext(common);
    },
    resolveModel: async () => ({
      value: await customModelProvider.getEngineModel(engine),
      descriptor: { engine },
    }),
    resolveBudget: input.resolveBudget,
  }).prepare({
    surface:
      input.request.executionSource === "delegation"
        ? "delegation"
        : "automation",
    runId: input.request.executionSource === "delegation" ? runId : undefined,
    userId: input.request.userId,
    workspaceId: input.request.workspaceId,
    taskId: input.request.taskId,
    agentId:
      input.profile.type === "custom" ? input.profile.agent.id : undefined,
    request: objective(input.request.input),
    goal: objective(input.request.input),
    selectedCapabilities: Object.keys(tools),
    instructions: input.instructions,
    contextWindow: 12_000,
  });
  const runtimeContext = prepared.runtimeContext!;
  const execution = {
    agent: {
      profile: input.profile,
      model: prepared.model!,
      instructions: prepared.instructions,
      tools,
      runtimeContext,
    },
    execution: {
      prompt: objective(input.request.input),
      abortSignal: input.request.signal,
      timeout: input.request.timeoutMs,
    },
    orchestration: {
      identity: {
        userId: input.request.userId,
        runId: runtimeContext.runId,
        requestId: runtimeContext.requestId,
        actorType: "agent",
        agentId:
          input.profile.type === "custom" ? input.profile.agent.id : undefined,
        workspaceId: input.request.workspaceId,
        taskId: input.request.taskId,
      },
      run:
        input.request.executionSource === "delegation"
          ? {
              mode: "claimed",
              claimToken: input.request.claimToken,
            }
          : {
              mode: "create",
              spec: {
                agentId:
                  input.profile.type === "custom"
                    ? input.profile.agent.id
                    : undefined,
                workspaceId: input.request.workspaceId,
                taskId: input.request.taskId,
                context: {
                  automationRunId: input.request.runId,
                  targetType: input.request.targetType,
                  targetId: input.request.targetId,
                  objective: objective(input.request.input),
                  goalRequirement: prepared.goalRequirement,
                },
                allowedTools: Object.keys(tools),
                timeoutMs: input.request.timeoutMs,
                budget: prepared.budget,
              },
            },
      policy: {
        ...prepared.policy!,
      },
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
        ...(prepared.snapshot.routing as {
          descriptorIds?: string[];
          diagnostics?: Record<string, unknown>;
        }),
        model: prepared.snapshot.model as Record<string, unknown>,
        driver: { driver: "ai-sdk" },
      },
      completionRequirement:
        prepared.completionRequirement ??
        createGoalVerificationRequirement(prepared.goalRequirement),
    } satisfies HarnessOrchestration,
  };
  const result = await (input.harness ?? irisHarness).generate(execution);
  return {
    status: "succeeded" as const,
    output: {
      text: result.text.slice(0, 32_000),
      totalTokens: result.usage.totalTokens,
    },
  };
}

export const defaultAutomationExecutionDependencies: AutomationExecutionDependencies =
  {
    workflow: async (request) => {
      if (
        !(await workflowRepository.checkAccess(
          request.targetId,
          request.userId,
        ))
      )
        return {
          status: "failed",
          errorCode: "TARGET_INACCESSIBLE",
          message: "Automation workflow is no longer accessible",
          retryable: false,
        };
      const workflow = await workflowRepository.selectStructureById(
        request.targetId,
      );
      if (!workflow)
        return {
          status: "failed",
          errorCode: "TARGET_NOT_FOUND",
          message: "Automation workflow was not found",
          retryable: false,
        };
      const sandboxRunId = generateUUID();
      const budget = await serverBudgetResolver({
        surface: "automation",
        userId: request.userId,
      });
      await runManager.start({
        id: sandboxRunId,
        userId: request.userId,
        workspaceId: request.workspaceId,
        context: {
          executionSource: "automation-workflow",
          automationRunId: request.runId,
          workflowId: request.targetId,
        },
        timeoutMs: request.timeoutMs,
        budget,
      });
      const result = await createWorkflowExecutor({
        edges: workflow.edges,
        nodes: workflow.nodes,
        context: {
          runId: sandboxRunId,
          userId: request.userId,
          workspaceId: request.workspaceId,
          signal: request.signal,
          services: workflowSandboxServices(sandboxRunId),
        },
      }).run(request.input as never, {
        disableHistory: true,
        timeout: request.timeoutMs,
      });
      await finishWorkflowAgentRun(sandboxRunId, result, runManager);
      await sandboxManager.cancelByRun(sandboxRunId).catch(() => undefined);
      return result.isOk
        ? {
            status: "succeeded",
            output: mapWorkflowOutput(result.output),
          }
        : classifyWorkflowFailure(result.error);
    },
    skill: async (request) => {
      const skill = await skillRepository.selectSkillById(
        request.targetId,
        request.userId,
      );
      if (!skill || skill.userId !== request.userId)
        return {
          status: "failed",
          errorCode: "TARGET_INACCESSIBLE",
          message: "Automation skill is no longer accessible",
          retryable: false,
        };
      const allowed = skill.allowedTools ?? [];
      const effective = request.allowedTools
        ? allowed.filter((tool) => request.allowedTools?.includes(tool))
        : allowed;
      return runHeadlessAgent({
        request,
        profile: { type: "base" },
        instructions: `${skill.description}\n\n${skill.body}`,
        allowedTools: effective,
      });
    },
    agent: async (request) => {
      const agent = await agentRepository.selectAgentById(
        request.targetId,
        request.userId,
      );
      if (!agent || agent.userId !== request.userId)
        return {
          status: "failed",
          errorCode: "TARGET_INACCESSIBLE",
          message: "Automation agent is no longer accessible",
          retryable: false,
        };
      return runHeadlessAgent({
        request,
        profile: { type: "custom", agent },
        instructions: [agent.instructions.role, agent.instructions.systemPrompt]
          .filter(Boolean)
          .join("\n\n"),
        allowedTools: request.allowedTools,
      });
    },
  };

export function createAutomationExecutionAdapter(
  dependencies = defaultAutomationExecutionDependencies,
) {
  return async (request: AutomationExecutionRequest) => {
    if (request.signal.aborted)
      return { status: "cancelled" as const, message: "Run was cancelled" };
    try {
      return await dependencies[request.targetType](request);
    } catch (error) {
      if (request.signal.aborted)
        return { status: "cancelled" as const, message: "Run was cancelled" };
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("VERIFICATION_REQUIRED:"))
        return {
          status: "failed" as const,
          errorCode: "VERIFICATION_REQUIRED",
          message: message.slice(0, 2_000),
          retryable: false,
        };
      if (isBudgetExhausted(error))
        return {
          status: "budget_exhausted" as const,
          message: message.slice(0, 2_000),
        };
      if (/timeout/i.test(message))
        return {
          status: "timed_out" as const,
          message: message.slice(0, 2_000),
        };
      return {
        status: "failed" as const,
        errorCode: "EXECUTION_ERROR",
        message: message.slice(0, 2_000),
        retryable: true,
      };
    }
  };
}
