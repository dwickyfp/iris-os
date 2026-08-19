import type { AgentSummary } from "app-types/agent";
import type { MCPToolInfo } from "app-types/mcp";
import type { RemoteAgent } from "app-types/remote-agent";
import type { SkillSummary } from "app-types/skill";
import type { WorkflowRepository, WorkflowSummary } from "app-types/workflow";
import { classifyToolName } from "../policy-engine";
import type {
  CapabilityDescriptor,
  CapabilityProvider,
  CapabilitySurface,
} from "./registry";

type NamedValue<T = unknown> = {
  key: string;
  name?: string;
  description?: string | null;
  value: T;
  surfaces?: readonly CapabilitySurface[];
  modelDescriptor?: unknown;
  risks?: CapabilityDescriptor["risks"];
};

type McpValue<T = unknown> = NamedValue<T> & {
  serverId: string;
  serverName?: string;
  tool: MCPToolInfo;
};

function descriptor<T>(
  value: NamedValue<T>,
  identity: Pick<CapabilityDescriptor, "id" | "kind"> & {
    hintIds?: readonly string[];
  },
): CapabilityDescriptor<T> {
  return {
    ...identity,
    key: value.key,
    name: value.name ?? value.key,
    description: value.description,
    surfaces: value.surfaces ?? ["executable", "model", "manual"],
    value: value.value,
    modelDescriptor: value.modelDescriptor,
    risks: value.risks,
  };
}

export function builtinCapabilities<Context, T>(
  load: (context: Context) => Promise<readonly NamedValue<T>[]>,
): CapabilityProvider<Context> {
  return {
    name: "builtins",
    async eligible(context) {
      return (await load(context)).map((item) =>
        descriptor(
          { ...item, risks: item.risks ?? classifyToolName(item.key) },
          { id: `builtin:${item.key}`, kind: "builtin" },
        ),
      );
    },
  };
}

export function mcpCapabilities<Context, T>(
  load: (context: Context) => Promise<readonly McpValue<T>[]>,
): CapabilityProvider<Context> {
  return {
    name: "mcp",
    async eligible(context) {
      return (await load(context)).map((item) =>
        descriptor(
          {
            ...item,
            name: item.name ?? item.tool.name,
            description: item.description ?? item.tool.description,
            risks: item.risks ?? ["write", "network"],
          },
          {
            id: `mcp:${item.serverId}:${item.tool.name}`,
            kind: "mcp",
            hintIds: [`mcp-server:${item.serverId}`],
          },
        ),
      );
    },
  };
}

export function workflowCapabilities<Context extends { userId: string }, T>(
  repository: Pick<WorkflowRepository, "selectExecuteAbility">,
  value: (workflow: WorkflowSummary, context: Context) => T,
): CapabilityProvider<Context> {
  return {
    name: "workflows",
    async eligible(context) {
      return (await repository.selectExecuteAbility(context.userId)).map(
        (workflow) =>
          descriptor(
            {
              key: workflow.name,
              name: workflow.name,
              description: workflow.description,
              value: value(workflow, context),
              risks: ["write"],
            },
            { id: `workflow:${workflow.id}`, kind: "workflow" },
          ),
      );
    },
  };
}

export function skillCapabilities<Context, T>(
  load: (context: Context) => Promise<readonly SkillSummary[]>,
  value: (skill: SkillSummary, context: Context) => T,
): CapabilityProvider<Context> {
  return entityProvider("skills", "skill", "skill", load, value, (skill) =>
    skill.archivedAt ? false : true,
  );
}

export function localPeerCapabilities<Context, T>(
  load: (context: Context) => Promise<readonly AgentSummary[]>,
  value: (agent: AgentSummary, context: Context) => T,
): CapabilityProvider<Context> {
  return entityProvider(
    "local-peers",
    "localPeer",
    "local-peer",
    load,
    value,
    () => true,
    [],
  );
}

export function remotePeerCapabilities<Context, T>(options: {
  enabled: (context: Context) => boolean;
  load: (context: Context) => Promise<readonly RemoteAgent[]>;
  value: (agent: RemoteAgent, context: Context) => T;
}): CapabilityProvider<Context> {
  return entityProvider(
    "remote-peers",
    "remotePeer",
    "remote-peer",
    async (context) => (options.enabled(context) ? options.load(context) : []),
    options.value,
    (agent) => agent.status === "active",
    [],
    (agent) => ({
      aliases: agent.agentCard?.name ? [agent.agentCard.name] : [],
      provider: semanticStrings(agent.agentCard?.provider),
      skills: (agent.agentCard?.skills ?? []).flatMap((skill) =>
        semanticStrings(skill),
      ),
    }),
  );
}

function entityProvider<
  Context,
  Entity extends { id: string; name: string; description?: string | null },
  T,
>(
  name: string,
  kind: CapabilityDescriptor["kind"],
  idPrefix: string,
  load: (context: Context) => Promise<readonly Entity[]>,
  value: (entity: Entity, context: Context) => T,
  include: (entity: Entity) => boolean = () => true,
  surfaces?: readonly CapabilitySurface[],
  search?: (entity: Entity) => CapabilityDescriptor["search"],
): CapabilityProvider<Context> {
  return {
    name,
    async eligible(context) {
      return (await load(context)).filter(include).map((entity) => ({
        ...descriptor(
          {
            key: entity.name,
            name: entity.name,
            description: entity.description,
            value: value(entity, context),
            surfaces,
          },
          { id: `${idPrefix}:${entity.id}`, kind },
        ),
        search: search?.(entity),
      }));
    },
  };
}

function semanticStrings(value: unknown, depth = 0): string[] {
  if (depth > 2) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .flatMap((item) => semanticStrings(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["url", "endpoint", "credential"].includes(key))
      .slice(0, 32)
      .flatMap(([, item]) => semanticStrings(item, depth + 1));
  }
  return [];
}
