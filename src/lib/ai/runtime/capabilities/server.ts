import "server-only";

import type { Tool } from "ai";
import type { Agent } from "app-types/agent";
import type { CapabilityHints, CapabilityRef } from "app-types/chat";
import type { VercelAIMcpTool } from "app-types/mcp";
import { mcpClientsManager } from "lib/ai/mcp/mcp-manager";
import {
  type AssignedSkillsRepository,
  type SkillsRuntime,
  createSkillsRuntime,
} from "lib/ai/skill";
import { selectScopedLearnedSkillSummaries } from "lib/ai/skill/scoped-learned";
import { createDelegateWorkTool } from "lib/ai/tools/delegation/delegate-work";
import { APP_DEFAULT_TOOL_KIT } from "lib/ai/tools/tool-kit";
import {
  agentRepository,
  remoteAgentRepository,
  skillRepository,
  workflowRepository,
} from "lib/db/repository";
import {
  type DelegationTarget,
  delegationTargetId,
} from "lib/delegation/targets";
import { isV2FeatureEnabled } from "lib/feature-flags";
import type { SandboxProvider } from "lib/sandbox";
import { sandboxCapabilityProvider } from "lib/sandbox";
import { sandboxCapability, workflowSandboxServices } from "lib/sandbox/server";
import { workflowToVercelAITool } from "../../../../app/api/chat/shared.chat";
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

export type ServerCapabilityContext = {
  userId: string;
  primaryAgentId?: string;
  allowedMcpServers?: Record<string, { tools: string[] }>;
  allowedAppDefaultToolkit?: string[];
  toolsEnabled: boolean;
  workflowsEnabled: boolean;
  delegationEnabled: boolean;
  remoteAgentsEnabled: boolean;
};

export type ServerCapabilityResolutionInput = Parameters<
  typeof resolveServerCapabilities
>[0];

export type ServerCapabilityBuildInput = {
  userId: string;
  workspaceId?: string;
  taskId?: string;
  runId: string;
  goal: string;
  agent?: Agent;
  hints?: CapabilityHints;
  permissions?: {
    allowedMcpServers?: Record<string, { tools: string[] }>;
    allowedAppDefaultToolkit?: string[];
  };
  featureState?: {
    tools: boolean;
    workflows: boolean;
    delegation: boolean;
    remoteAgents: boolean;
    learning: boolean;
  };
  additionalTools?: Record<string, Tool>;
  workflowBinding?: {
    dataStream?: { write(value: unknown): void };
    signal?: AbortSignal;
  };
  dependencies?: {
    skillsRepository?: AssignedSkillsRepository;
    selectScopedSkills?: typeof selectScopedLearnedSkillSummaries;
  };
};

export type CapabilitySubtraction = {
  id: string;
  key: string;
  reason: "automation_tool_allowlist";
};

export function subtractAutomationCapabilities<
  Descriptor extends { id: string; key: string },
>(descriptors: readonly Descriptor[], allowedTools?: readonly string[]) {
  if (allowedTools === undefined)
    return { descriptors: [...descriptors], subtractions: [] };
  const allowed = new Set(allowedTools);
  return {
    descriptors: descriptors.filter(({ key }) => allowed.has(key)),
    subtractions: descriptors
      .filter(({ key }) => !allowed.has(key))
      .map(
        ({ id, key }): CapabilitySubtraction => ({
          id,
          key,
          reason: "automation_tool_allowlist",
        }),
      ),
  };
}

function agentCapabilityAuthority(agent?: Agent): CapabilityRef[] | undefined {
  if (!agent) return undefined;
  return [
    ...(agent.instructions.mentions ?? []),
    ...(agent.instructions.capabilities ?? []),
  ].filter(
    (capability): capability is CapabilityRef => capability.type !== "agent",
  );
}

/** Builds the production registry input shared by foreground and headless runs. */
export async function buildServerCapabilityResolutionInput(
  input: ServerCapabilityBuildInput,
): Promise<ServerCapabilityResolutionInput> {
  const features = input.featureState ?? {
    tools: true,
    workflows: true,
    delegation: isV2FeatureEnabled("delegation"),
    remoteAgents: isV2FeatureEnabled("remoteAgents"),
    learning: isV2FeatureEnabled("learning"),
  };
  const scopedSkills =
    features.tools && features.learning
      ? await (
          input.dependencies?.selectScopedSkills ??
          selectScopedLearnedSkillSummaries
        )({
          userId: input.userId,
          query: input.goal,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          agentId: input.agent?.id,
        })
      : [];
  const skillsRuntime = features.tools
    ? await createSkillsRuntime({
        repository:
          input.dependencies?.skillsRepository ??
          (skillRepository as AssignedSkillsRepository),
        agentId: input.agent?.id,
        userId: input.userId,
        additionalSkills: scopedSkills,
      })
    : emptySkillsRuntime();

  return {
    query: input.goal,
    context: {
      userId: input.userId,
      primaryAgentId: input.agent?.id,
      allowedMcpServers: input.permissions?.allowedMcpServers,
      allowedAppDefaultToolkit: input.permissions?.allowedAppDefaultToolkit,
      toolsEnabled: features.tools,
      workflowsEnabled: features.tools && features.workflows,
      delegationEnabled: features.tools && features.delegation,
      remoteAgentsEnabled: features.remoteAgents,
    },
    hints: input.hints ?? { mode: "prefer", requested: [] },
    allowedCapabilities: agentCapabilityAuthority(input.agent),
    skillsRuntime,
    workflowTool: (workflow) =>
      workflowToVercelAITool({
        ...workflow,
        dataStream: input.workflowBinding?.dataStream ?? { write() {} },
        executionContext: {
          runId: input.runId,
          userId: input.userId,
          workspaceId: input.workspaceId,
          taskId: input.taskId,
          signal: input.workflowBinding?.signal,
          services: workflowSandboxServices(input.runId),
        },
      } as any),
    additionalTools: input.additionalTools,
    createDelegationTool: (targets) =>
      createDelegateWorkTool({
        parentRunId: input.runId,
        userId: input.userId,
        targets,
      }),
    sandbox: sandboxCapability,
  };
}

function emptySkillsRuntime(): SkillsRuntime {
  return {
    manifest: [],
    tools: {},
    select() {
      return this;
    },
  };
}

function capabilityRouterConfig() {
  return {
    threshold: configuredNumber("CAPABILITY_ROUTER_THRESHOLD", 20),
    topN: configuredNumber("CAPABILITY_ROUTER_TOP_N", 12),
    minScore: configuredNumber("CAPABILITY_ROUTER_MIN_SCORE", 0.15),
    timeoutMs: configuredNumber("CAPABILITY_ROUTER_TIMEOUT_MS", 25),
    fallbackHardCap: configuredNumber(
      "CAPABILITY_ROUTER_FALLBACK_HARD_CAP",
      100,
    ),
  };
}

function configuredNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value)
    ? value
    : fallback;
}

export async function resolveServerCapabilities(input: {
  context: ServerCapabilityContext;
  hints: CapabilityHints;
  allowedCapabilities?: readonly CapabilityRef[];
  skillsRuntime: SkillsRuntime;
  workflowTool: (workflow: any) => Tool;
  additionalTools?: Record<string, Tool>;
  createDelegationTool: (targets: readonly DelegationTarget[]) => Tool;
  query?: string;
  sandbox?: {
    provider: SandboxProvider;
    pythonCompute: Tool;
  };
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
    ...(input.sandbox ? [sandboxCapabilityProvider(input.sandbox)] : []),
  ];
  const resolved = await new CapabilityRegistry(providers).resolve(
    context,
    input.hints,
    input.allowedCapabilities,
    { query: input.query, config: capabilityRouterConfig() },
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
          search: {
            skills: runtime.manifest.flatMap(({ id, name }) => [id, name]),
          },
        }),
      );
    },
  };
}
