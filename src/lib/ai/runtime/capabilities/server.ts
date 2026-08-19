import "server-only";

import type { Tool } from "ai";
import type { CapabilityHints, CapabilityRef } from "app-types/chat";
import type { VercelAIMcpTool } from "app-types/mcp";
import { mcpClientsManager } from "lib/ai/mcp/mcp-manager";
import type { SkillsRuntime } from "lib/ai/skill";
import { APP_DEFAULT_TOOL_KIT } from "lib/ai/tools/tool-kit";
import {
  agentRepository,
  remoteAgentRepository,
  workflowRepository,
} from "lib/db/repository";
import {
  type DelegationTarget,
  delegationTargetId,
} from "lib/delegation/targets";
import {
  builtinCapabilities,
  localPeerCapabilities,
  mcpCapabilities,
  remotePeerCapabilities,
  workflowCapabilities,
} from "./providers";
import {
  type CapabilityDescriptor,
  type CapabilityProvider,
  CapabilityRegistry,
} from "./registry";

type ServerCapabilityContext = {
  userId: string;
  primaryAgentId?: string;
  allowedMcpServers?: Record<string, { tools: string[] }>;
  allowedAppDefaultToolkit?: string[];
  toolsEnabled: boolean;
  workflowsEnabled: boolean;
  delegationEnabled: boolean;
  remoteAgentsEnabled: boolean;
};

export async function resolveServerCapabilities(input: {
  context: ServerCapabilityContext;
  hints: CapabilityHints;
  allowedCapabilities?: readonly CapabilityRef[];
  skillsRuntime: SkillsRuntime;
  workflowTool: (workflow: any) => Tool;
  additionalTools?: Record<string, Tool>;
  createDelegationTool: (targets: readonly DelegationTarget[]) => Tool;
}) {
  const { context } = input;
  const requestedSkillIds = input.hints.requested.flatMap((hint) =>
    hint.type === "skill" ? [hint.skillId] : [],
  );
  const allowedSkillIds = input.allowedCapabilities?.flatMap((capability) =>
    capability.type === "skill" ? [capability.skillId] : [],
  );
  const eligibleSkillIds =
    allowedSkillIds ?? input.skillsRuntime.manifest.map(({ id }) => id);
  const routedSkillsRuntime = input.skillsRuntime.select(
    input.hints.mode === "only"
      ? requestedSkillIds.filter((id) => eligibleSkillIds.includes(id))
      : eligibleSkillIds,
  );
  const providers: CapabilityProvider<ServerCapabilityContext>[] = [
    builtinCapabilities(async ({ allowedAppDefaultToolkit, toolsEnabled }) => {
      const toolkitNames = toolsEnabled
        ? (allowedAppDefaultToolkit ?? Object.keys(APP_DEFAULT_TOOL_KIT))
        : [];
      const tools = toolkitNames.reduce<Record<string, Tool>>(
        (result, toolkit) => ({
          ...result,
          ...(APP_DEFAULT_TOOL_KIT as Record<string, Record<string, Tool>>)[
            toolkit
          ],
        }),
        { ...input.additionalTools },
      );
      return Object.entries(tools).map(([key, value]) => ({ key, value }));
    }),
    mcpCapabilities(async ({ allowedMcpServers, toolsEnabled }) => {
      if (!toolsEnabled) return [];
      const authorized = allowedMcpServers ?? {};
      return Object.entries(mcpClientsManager.tools()).flatMap(
        ([key, value]) => {
          const tool = value as VercelAIMcpTool;
          if (
            !authorized[tool._mcpServerId]?.tools.includes(tool._originToolName)
          )
            return [];
          return [
            {
              key,
              serverId: tool._mcpServerId,
              serverName: tool._mcpServerName,
              tool: {
                name: tool._originToolName,
                description:
                  typeof tool.description === "string" ? tool.description : "",
              },
              value: tool,
            },
          ];
        },
      );
    }),
    ...(context.workflowsEnabled
      ? [
          workflowCapabilities(workflowRepository, (workflow) =>
            input.workflowTool({ ...workflow, schema: workflow.schema! }),
          ),
        ]
      : []),
    localPeerCapabilities(
      async ({ userId, primaryAgentId, delegationEnabled }) =>
        delegationEnabled
          ? (await agentRepository.selectAgentsByUserId(userId)).filter(
              ({ id }) => id !== primaryAgentId,
            )
          : [],
      (agent) => ({
        kind: "local" as const,
        agentId: agent.id,
        name: agent.name,
        description: agent.description,
      }),
    ),
    remotePeerCapabilities({
      enabled: ({ delegationEnabled, remoteAgentsEnabled }) =>
        delegationEnabled && remoteAgentsEnabled,
      load: ({ userId }) => remoteAgentRepository.listByUserId(userId),
      value: (agent) => ({
        kind: "remote" as const,
        connectionId: agent.id,
        name: agent.name,
        description: agent.agentCard?.description,
      }),
    }),
    skillRuntimeProvider(routedSkillsRuntime),
  ];
  const resolved = await new CapabilityRegistry(providers).resolve(
    context,
    input.hints,
    input.allowedCapabilities,
  );
  const targets = resolved.ordered
    .filter(
      (descriptor) =>
        descriptor.kind === "localPeer" || descriptor.kind === "remotePeer",
    )
    .map(({ value }) => value as DelegationTarget);

  // Delegation is a reserved, registry-derived capability, never a provider tool.
  delete resolved.executable.delegate_agent;
  delete resolved.model.delegate_agent;
  delete resolved.manual.delegate_agent;
  if (targets.length > 0) {
    const delegate = input.createDelegationTool(targets);
    resolved.executable.delegate_agent = delegate;
    resolved.model.delegate_agent = delegate;
    resolved.manual.delegate_agent = delegate;
  }

  return {
    ...resolved,
    delegationTargets: targets,
    eligibleDelegationTargets: targets.map(delegationTargetId),
    skillManifest: routedSkillsRuntime.manifest,
  };
}

function skillRuntimeProvider(
  runtime: SkillsRuntime,
): CapabilityProvider<ServerCapabilityContext> {
  const hintIds = runtime.manifest.map(({ id }) => `skill:${id}`);
  return {
    name: "skills-runtime",
    async eligible() {
      return Object.entries(runtime.tools).map(
        ([key, value]): CapabilityDescriptor<Tool> => ({
          id: `skill-runtime:${key}`,
          key,
          kind: "skill",
          name: key,
          description:
            typeof value.description === "string"
              ? value.description
              : undefined,
          surfaces: ["executable", "model", "manual"],
          value,
          hintIds,
        }),
      );
    },
  };
}
