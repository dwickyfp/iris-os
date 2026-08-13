import type { Agent } from "app-types/agent";
import type { SkillManifestEntry } from "../skill";

export type AgentRuntimeContext = {
  requestId: string;
  userId: string;
  threadId: string;
  agentType: "base" | "custom";
  agentId?: string;
  userRole?: string;
  toolChoice?: string;
  skills: SkillManifestEntry[];
};

export function createAgentRuntimeContext({
  requestId,
  userId,
  threadId,
  agent,
  userRole,
  toolChoice,
  skills = [],
}: {
  requestId: string;
  userId: string;
  threadId: string;
  agent: Agent;
  userRole?: string;
  toolChoice?: string;
  skills?: SkillManifestEntry[];
}): AgentRuntimeContext {
  return {
    requestId,
    userId,
    threadId,
    agentType: "custom",
    agentId: agent.id,
    userRole,
    toolChoice,
    skills,
  };
}

export function createBaseAgentRuntimeContext({
  requestId,
  userId,
  threadId,
  userRole,
  toolChoice,
}: Omit<
  AgentRuntimeContext,
  "agentType" | "agentId" | "skills"
>): AgentRuntimeContext {
  return {
    requestId,
    userId,
    threadId,
    agentType: "base",
    userRole,
    toolChoice,
    skills: [],
  };
}
