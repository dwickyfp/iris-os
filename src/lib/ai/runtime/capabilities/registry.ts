import type { CapabilityHints, CapabilityRef, ChatModel } from "app-types/chat";

export type CapabilityKind =
  | "builtin"
  | "mcp"
  | "workflow"
  | "skill"
  | "localPeer"
  | "remotePeer"
  | "model";

export type CapabilitySurface = "executable" | "model" | "manual";

export type CapabilityDescriptor<T = unknown> = {
  /** Stable, globally unique identity used by hints. */
  id: string;
  /** Runtime-facing name. Duplicate keys are removed fail-closed. */
  key: string;
  kind: CapabilityKind;
  name: string;
  description?: string | null;
  surfaces: readonly CapabilitySurface[];
  value: T;
  modelDescriptor?: unknown;
  hintIds?: readonly string[];
};

export type CapabilityProvider<Context = unknown> = {
  name: string;
  eligible(context: Context): Promise<readonly CapabilityDescriptor[]>;
};

export type CapabilityCollision = {
  key: string;
  capabilityIds: string[];
  providers: string[];
};

export type ResolvedCapabilities = {
  ordered: CapabilityDescriptor[];
  executable: Record<string, unknown>;
  model: Record<string, unknown>;
  manual: Record<string, unknown>;
  collisions: CapabilityCollision[];
};

function capabilityRefId(hint: CapabilityRef) {
  switch (hint.type) {
    case "defaultTool":
      return `builtin:${hint.name}`;
    case "mcpTool":
      return `mcp:${hint.serverId}:${hint.name}`;
    case "mcpServer":
      return `mcp-server:${hint.serverId}`;
    case "workflow":
      return `workflow:${hint.workflowId}`;
    case "skill":
      return `skill:${hint.skillId}`;
    case "peerAgent":
      return `local-peer:${hint.agentId}`;
    case "remoteAgent":
      return `remote-peer:${hint.agentId}`;
  }
}

function toMap(
  descriptors: readonly CapabilityDescriptor[],
  surface: CapabilitySurface,
) {
  return Object.fromEntries(
    descriptors
      .filter((descriptor) => descriptor.surfaces.includes(surface))
      .map((descriptor) => [
        descriptor.key,
        surface === "model"
          ? (descriptor.modelDescriptor ?? descriptor.value)
          : descriptor.value,
      ]),
  );
}

/** Resolves capabilities from authorized provider listings, never from hints. */
export class CapabilityRegistry<Context = unknown> {
  constructor(
    private readonly providers: readonly CapabilityProvider<Context>[],
  ) {}

  async resolve(
    context: Context,
    hints: CapabilityHints = { requested: [], mode: "prefer" },
    allowed?: readonly CapabilityRef[],
  ): Promise<ResolvedCapabilities> {
    const batches = await Promise.all(
      this.providers.map(async (provider) => ({
        provider: provider.name,
        descriptors: await provider.eligible(context),
      })),
    );
    const candidates = batches.flatMap(({ provider, descriptors }) =>
      descriptors.map((descriptor) => ({ descriptor, provider })),
    );

    const byKey = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      const entries = byKey.get(candidate.descriptor.key) ?? [];
      entries.push(candidate);
      byKey.set(candidate.descriptor.key, entries);
    }

    const collisions: CapabilityCollision[] = [];
    const collisionKeys = new Set<string>();
    for (const [key, entries] of byKey) {
      if (entries.length < 2) continue;
      collisionKeys.add(key);
      collisions.push({
        key,
        capabilityIds: entries.map(({ descriptor }) => descriptor.id),
        providers: entries.map(({ provider }) => provider),
      });
    }

    const allowedIds = allowed?.map(capabilityRefId);
    const allowedSet = allowedIds ? new Set(allowedIds) : undefined;
    const isAllowed = (descriptor: CapabilityDescriptor) =>
      allowedSet === undefined ||
      allowedSet.has(descriptor.id) ||
      descriptor.hintIds?.some((id) => allowedSet.has(id)) === true;
    const eligible = candidates
      .map(({ descriptor }) => descriptor)
      .filter(
        (descriptor) =>
          !collisionKeys.has(descriptor.key) && isAllowed(descriptor),
      );
    const requestedIds = hints.requested.map(capabilityRefId);
    const requested = new Set(requestedIds);
    const isRequested = (descriptor: CapabilityDescriptor) =>
      requested.has(descriptor.id) ||
      descriptor.hintIds?.some((id) => requested.has(id)) === true;

    let ordered: CapabilityDescriptor[];
    if (hints.mode === "only") {
      ordered = eligible.filter(isRequested);
    } else {
      const rank = new Map(requestedIds.map((id, index) => [id, index]));
      const requestedRank = (descriptor: CapabilityDescriptor) => {
        const ids = [descriptor.id, ...(descriptor.hintIds ?? [])];
        return Math.min(
          ...ids.map((id) => rank.get(id) ?? Number.POSITIVE_INFINITY),
        );
      };
      ordered = eligible
        .map((descriptor, index) => ({ descriptor, index }))
        .sort(
          (a, b) =>
            requestedRank(a.descriptor) - requestedRank(b.descriptor) ||
            a.index - b.index,
        )
        .map(({ descriptor }) => descriptor);
    }

    return {
      ordered,
      executable: toMap(ordered, "executable"),
      model: toMap(ordered, "model"),
      manual: toMap(ordered, "manual"),
      collisions,
    };
  }
}

export function modelCapabilityDescriptor<T>(input: {
  model: ChatModel;
  value: T;
  descriptor?: unknown;
}): CapabilityDescriptor<T> {
  const id = `model:${input.model.provider}:${input.model.model}`;
  return {
    id,
    key: id,
    kind: "model",
    name: input.model.model,
    surfaces: ["model"],
    value: input.value,
    modelDescriptor: input.descriptor,
  };
}
