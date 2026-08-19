import type { AgentSummary } from "app-types/agent";
import type { MCPToolInfo } from "app-types/mcp";
import type { RemoteAgent } from "app-types/remote-agent";
import type { SkillSummary } from "app-types/skill";
import type { WorkflowRepository, WorkflowSummary } from "app-types/workflow";
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
  };
}

export function builtinCapabilities<Context, T>(
  load: (context: Context) => Promise<readonly NamedValue<T>[]>,
): CapabilityProvider<Context> {
  return {
    name: "builtins",
    async eligible(context) {
      return (await load(context)).map((item) =>
        descriptor(item, { id: `builtin:${item.key}`, kind: "builtin" }),
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
): CapabilityProvider<Context> {
  return {
    name,
    async eligible(context) {
      return (await load(context)).filter(include).map((entity) =>
        descriptor(
          {
            key: entity.name,
            name: entity.name,
              description: entity.description,
              value: value(entity, context),
              surfaces,
          },
          { id: `${idPrefix}:${entity.id}`, kind },
        ),
      );
    },
  };
}
