import "server-only";

import type { Agent } from "app-types/agent";
import type { Tool } from "ai";
import { createToolLoopAgent } from "lib/ai/agent/create-tool-loop-agent";
import {
  createAgentRuntimeContext,
  createBaseAgentRuntimeContext,
} from "lib/ai/agent/runtime-context";
import { customModelProvider } from "lib/ai/models";
import { APP_DEFAULT_TOOL_KIT } from "lib/ai/tools/tool-kit";
import { createWorkflowExecutor } from "lib/ai/workflow/executor/workflow-executor";
import {
  agentRepository,
  skillRepository,
  workflowRepository,
} from "lib/db/repository";
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
  | { status: "timed_out"; message: string };

export type AutomationExecutionRequest = {
  runId: string;
  userId: string;
  workspaceId?: string;
  targetType: AutomationTarget;
  targetId: string;
  input: Record<string, unknown>;
  allowedTools?: string[];
  timeoutMs: number;
  signal: AbortSignal;
  executionSource: "automation" | "delegation";
};

type TargetExecutor = (
  request: AutomationExecutionRequest,
) => Promise<AutomationExecutionResult>;

export type AutomationExecutionDependencies = Record<
  AutomationTarget,
  TargetExecutor
>;

function objective(input: Record<string, unknown>) {
  const explicit = input.objective ?? input.prompt;
  return typeof explicit === "string" && explicit.trim()
    ? explicit.trim()
    : JSON.stringify(input);
}

function availableTools(allowedTools: string[]) {
  const all = Object.assign(
    {},
    ...Object.values(APP_DEFAULT_TOOL_KIT),
  ) as Record<string, Tool>;
  const allowed = new Set(allowedTools);
  return Object.fromEntries(
    Object.entries(all).filter(([name]) => allowed.has(name)),
  );
}

async function runHeadlessAgent(input: {
  request: AutomationExecutionRequest;
  profile: { type: "base" } | { type: "custom"; agent: Agent };
  instructions: string;
  allowedTools: string[];
}) {
  const model = await customModelProvider.getEngineModel(
    input.request.executionSource === "delegation"
      ? "delegation-runner"
      : "automation-runner",
  );
  const runtimeContext =
    input.profile.type === "custom"
      ? createAgentRuntimeContext({
          requestId: generateUUID(),
          runId: input.request.runId,
          userId: input.request.userId,
          workspaceId: input.request.workspaceId,
          agent: input.profile.agent,
          toolMode: "auto",
          approvalPolicy: "never",
        })
      : createBaseAgentRuntimeContext({
          requestId: generateUUID(),
          runId: input.request.runId,
          userId: input.request.userId,
          workspaceId: input.request.workspaceId,
          toolMode: "auto",
          approvalPolicy: "never",
        });
  const runner = createToolLoopAgent({
    profile: input.profile,
    model,
    instructions: input.instructions,
    tools: availableTools(input.allowedTools),
    runtimeContext,
  });
  const result = await runner.generate({
    prompt: objective(input.request.input),
    abortSignal: input.request.signal,
    timeout: input.request.timeoutMs,
  });
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
      const result = await createWorkflowExecutor({
        edges: workflow.edges,
        nodes: workflow.nodes,
      }).run(request.input as never, {
        disableHistory: true,
        timeout: request.timeoutMs,
      });
      return result.isOk
        ? { status: "succeeded", output: { targetId: request.targetId } }
        : {
            status: "failed",
            errorCode: "WORKFLOW_FAILED",
            message: String(result.error).slice(0, 2_000),
            retryable: true,
          };
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
      const skills = await skillRepository.selectSkillsByAgentId(
        agent.id,
        request.userId,
      );
      const allowed = skills.flatMap((skill) => skill.allowedTools ?? []);
      const effective = request.allowedTools
        ? allowed.filter((tool) => request.allowedTools?.includes(tool))
        : allowed;
      return runHeadlessAgent({
        request,
        profile: { type: "custom", agent },
        instructions: [agent.instructions.role, agent.instructions.systemPrompt]
          .filter(Boolean)
          .join("\n\n"),
        allowedTools: effective,
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
