import "server-only";

import type { CapabilityRef } from "app-types/chat";
import { NodeKind } from "lib/ai/workflow/workflow.interface";
import {
  agentRepository,
  skillRepository,
  workflowRepository,
} from "lib/db/repository";

export type AutomationAuthoritySnapshot = {
  version: 1;
  allowedTools: string[];
  capabilityIds: string[];
};

function unique(values: string[]) {
  return [...new Set(values)].sort();
}

function capabilityId(capability: CapabilityRef) {
  switch (capability.type) {
    case "defaultTool":
      return `builtin:${capability.name}`;
    case "mcpTool":
      return `mcp:${capability.serverId}:${capability.name}`;
    case "mcpServer":
      return `mcp-server:${capability.serverId}`;
    case "workflow":
      return `workflow:${capability.workflowId}`;
    case "skill":
      return `skill:${capability.skillId}`;
    case "peerAgent":
      return `local-peer:${capability.agentId}`;
    case "remoteAgent":
      return `remote-peer:${capability.agentId}`;
  }
}

export function workflowAuthoritySnapshot(
  nodes: { kind: string; nodeConfig: any }[],
) {
  const capabilityIds: string[] = [];
  const allowedTools: string[] = [];
  for (const node of nodes) {
    if (node.kind === NodeKind.Tool && node.nodeConfig?.tool) {
      const tool = node.nodeConfig.tool;
      if (typeof tool.id !== "string") continue;
      allowedTools.push(tool.id);
      if (tool.type === "mcp-tool" && typeof tool.serverId === "string")
        capabilityIds.push(`mcp:${tool.serverId}:${tool.id}`);
      if (tool.type === "app-tool") capabilityIds.push(`builtin:${tool.id}`);
    }
    if (node.kind === NodeKind.Http) capabilityIds.push("workflow:http");
    if (node.kind === NodeKind.Compute)
      capabilityIds.push("sandbox:execute_python");
  }
  return {
    version: 1 as const,
    allowedTools: unique(allowedTools),
    capabilityIds: unique(capabilityIds),
  };
}

export async function resolveAutomationAuthority(input: {
  targetType: "workflow" | "skill" | "agent";
  targetId: string;
  userId: string;
}): Promise<AutomationAuthoritySnapshot> {
  if (input.targetType === "workflow") {
    const workflow = await workflowRepository.selectStructureById(input.targetId);
    if (!workflow || !(await workflowRepository.checkAccess(input.targetId, input.userId)))
      throw new Error("AUTOMATION_TARGET_NOT_FOUND");
    return workflowAuthoritySnapshot(workflow.nodes);
  }
  if (input.targetType === "skill") {
    const skill = await skillRepository.selectSkillById(
      input.targetId,
      input.userId,
    );
    if (!skill || skill.userId !== input.userId)
      throw new Error("AUTOMATION_TARGET_NOT_FOUND");
    const allowedTools = unique(skill.allowedTools ?? []);
    return {
      version: 1,
      allowedTools,
      capabilityIds: [],
    };
  }
  const agent = await agentRepository.selectAgentById(
    input.targetId,
    input.userId,
  );
  if (!agent || agent.userId !== input.userId)
    throw new Error("AUTOMATION_TARGET_NOT_FOUND");
  const capabilities = [
    ...(agent.instructions.mentions ?? []),
    ...(agent.instructions.capabilities ?? []),
  ].filter((value): value is CapabilityRef => value.type !== "agent");
  return {
    version: 1,
    allowedTools: unique(
      capabilities.flatMap((capability) =>
        capability.type === "defaultTool" || capability.type === "mcpTool"
          ? [capability.name]
          : [],
      ),
    ),
    capabilityIds: unique(capabilities.map(capabilityId)),
  };
}

export function intersectAutomationAuthority(
  persisted: AutomationAuthoritySnapshot,
  current: AutomationAuthoritySnapshot,
): AutomationAuthoritySnapshot {
  const currentTools = new Set(current.allowedTools);
  const currentCapabilities = new Set(current.capabilityIds);
  return {
    version: 1,
    allowedTools: persisted.allowedTools.filter((tool) => currentTools.has(tool)),
    capabilityIds: persisted.capabilityIds.filter((id) =>
      currentCapabilities.has(id),
    ),
  };
}
