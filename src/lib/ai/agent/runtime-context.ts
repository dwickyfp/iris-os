import type { Agent } from "app-types/agent";
import type { SkillManifestEntry } from "../skill";

export type RuntimeToolMode = "auto" | "manual" | "none";
export type ApprovalPolicy = "always" | "destructive_only" | "never";

export type AgentRuntimeContext = {
  requestId: string;
  runId: string;
  parentRunId?: string;
  userId: string;
  workspaceId?: string;
  threadId?: string;
  taskId?: string;
  agentType: "base" | "custom";
  agentId?: string;
  userRole?: string;
  toolMode: RuntimeToolMode;
  approvalPolicy: ApprovalPolicy;
  skills: SkillManifestEntry[];
};

export function createAgentRuntimeContext({
  requestId,
  runId,
  parentRunId,
  userId,
  workspaceId,
  threadId,
  taskId,
  agent,
  userRole,
  toolMode,
  approvalPolicy,
  skills = [],
}: {
  requestId: string;
  runId: string;
  parentRunId?: string;
  userId: string;
  workspaceId?: string;
  threadId?: string;
  taskId?: string;
  agent: Agent;
  userRole?: string;
  toolMode: RuntimeToolMode;
  approvalPolicy: ApprovalPolicy;
  skills?: SkillManifestEntry[];
}): AgentRuntimeContext {
  return {
    requestId,
    runId,
    parentRunId,
    userId,
    workspaceId,
    threadId,
    taskId,
    agentType: "custom",
    agentId: agent.id,
    userRole,
    toolMode,
    approvalPolicy,
    skills,
  };
}

export function createBaseAgentRuntimeContext({
  requestId,
  runId,
  parentRunId,
  userId,
  workspaceId,
  threadId,
  taskId,
  userRole,
  toolMode,
  approvalPolicy,
}: Omit<
  AgentRuntimeContext,
  "agentType" | "agentId" | "skills"
>): AgentRuntimeContext {
  return {
    requestId,
    runId,
    parentRunId,
    userId,
    workspaceId,
    threadId,
    taskId,
    agentType: "base",
    userRole,
    toolMode,
    approvalPolicy,
    skills: [],
  };
}
