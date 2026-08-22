import type {
  CapabilityHealth,
  CapabilityHealthStatus,
} from "app-types/capability-health";
import type { CapabilityHints, CapabilityRef, ChatModel } from "app-types/chat";
import type { PolicyRisk } from "../policy-engine";
import {
  type CapabilityRouterConfig,
  type CapabilityRoutingDiagnostics,
  capabilitySearchDocument,
  routeCapabilityDocuments,
} from "./semantic-router";

export type CapabilityKind =
  | "builtin"
  | "mcp"
  | "workflow"
  | "skill"
  | "localPeer"
  | "remotePeer"
  | "sandbox"
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
  search?: {
    aliases?: readonly string[];
    provider?: readonly string[];
    skills?: readonly string[];
  };
  /** Trusted, additive governance classification. Request hints never alter it. */
  risks?: readonly PolicyRisk[];
  metadata?: Record<string, unknown>;
  health?: CapabilityHealth;
};

export type CapabilityProvider<Context = unknown> = {
  name: string;
  metadata?: Record<string, unknown>;
  readiness?(context: Context): Promise<{
    status?: CapabilityHealthStatus;
    ready?: boolean;
    reason?: string;
    metadata?: Record<string, unknown>;
  }>;
  eligible(context: Context): Promise<readonly CapabilityDescriptor[]>;
};

export type CapabilityProviderResolution = {
  name: string;
  status: CapabilityHealthStatus;
  ready: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type CapabilityHealthDiagnostic = CapabilityHealth & {
  id: string;
  provider: string;
  eligible: boolean;
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
  routing: CapabilityRoutingDiagnostics;
  providers: CapabilityProviderResolution[];
  health: CapabilityHealthDiagnostic[];
};

export type CapabilityRoutingRequest = {
  query?: string;
  config?: Partial<CapabilityRouterConfig>;
  now?: () => number;
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
    routing: CapabilityRoutingRequest = {},
  ): Promise<ResolvedCapabilities> {
    const batches = await Promise.all(
      this.providers.map(async (provider) => {
        const readiness = (await provider.readiness?.(context)) ?? {
          status: "healthy" as const,
        };
        const status =
          readiness.status ?? (readiness.ready ? "healthy" : "unavailable");
        const ready = statusEligible(status);
        return {
          provider: provider.name,
          providerResolution: {
            name: provider.name,
            status,
            ready,
            reason: readiness.reason,
            metadata: { ...provider.metadata, ...readiness.metadata },
          },
          descriptors: ready ? await provider.eligible(context) : [],
        };
      }),
    );
    const observed = batches.flatMap(({ provider, descriptors }) =>
      descriptors.map((descriptor) => ({
        descriptor: {
          ...descriptor,
          health: descriptor.health ?? { status: "healthy" as const },
        },
        provider,
      })),
    );
    const candidates = observed.filter(({ descriptor }) =>
      statusEligible(descriptor.health.status),
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
    const routingEligible = eligible.filter(
      (descriptor) =>
        descriptor.health?.status !== "auth_required" ||
        isRequested(descriptor),
    );

    let ordered: CapabilityDescriptor[];
    let routingDiagnostics: CapabilityRoutingDiagnostics;
    if (hints.mode === "only") {
      ordered = routingEligible.filter(isRequested);
      routingDiagnostics = {
        event: "capability.routing",
        strategy: "only",
        candidateCount: routingEligible.length,
        selectedCount: ordered.length,
        threshold: routing.config?.threshold ?? 20,
        topN: routing.config?.topN ?? ordered.length,
        fallbackHardCap: routing.config?.fallbackHardCap ?? 100,
        minScore: routing.config?.minScore ?? 0,
        elapsedMs: 0,
        reductionRate:
          routingEligible.length === 0
            ? 0
            : 1 - ordered.length / routingEligible.length,
        signal: "not-evaluated",
        clarificationRequired: false,
        pinnedIds: ordered.map(({ id }) => id),
        selectedIds: ordered.map(({ id }) => id),
        scores: [],
      };
    } else {
      const rank = new Map(requestedIds.map((id, index) => [id, index]));
      const requestedRank = (descriptor: CapabilityDescriptor) => {
        const ids = [descriptor.id, ...(descriptor.hintIds ?? [])];
        return Math.min(
          ...ids.map((id) => rank.get(id) ?? Number.POSITIVE_INFINITY),
        );
      };
      const preferred = routingEligible
        .map((descriptor, index) => ({ descriptor, index }))
        .sort(
          (a, b) =>
            requestedRank(a.descriptor) - requestedRank(b.descriptor) ||
            healthTier(a.descriptor) - healthTier(b.descriptor) ||
            a.index - b.index,
        )
        .map(({ descriptor }) => descriptor);
      const routed = routeCapabilityDocuments(
        preferred.map((descriptor) => {
          const provider = candidates.find(
            (candidate) => candidate.descriptor === descriptor,
          )?.provider;
          return capabilitySearchDocument(descriptor, provider);
        }),
        routing.query ?? "",
        new Set(preferred.filter(isRequested).map(({ id }) => id)),
        { config: routing.config, now: routing.now },
      );
      const byId = new Map(
        preferred.map((descriptor) => [descriptor.id, descriptor]),
      );
      ordered = routed.selectedIds.flatMap((id) => {
        const descriptor = byId.get(id);
        return descriptor ? [descriptor] : [];
      });
      routingDiagnostics = routed.diagnostics;
    }

    return {
      ordered,
      executable: toMap(ordered, "executable"),
      model: toMap(ordered, "model"),
      manual: toMap(ordered, "manual"),
      collisions,
      routing: routingDiagnostics,
      providers: batches.map(({ providerResolution }) => providerResolution),
      health: observed.map(({ descriptor, provider }) => ({
        id: descriptor.id,
        provider,
        ...descriptor.health,
        eligible: statusEligible(descriptor.health.status),
      })),
    };
  }
}

function statusEligible(status: CapabilityHealthStatus) {
  return status !== "unavailable" && status !== "disabled";
}

function healthTier(descriptor: CapabilityDescriptor) {
  switch (descriptor.health?.status) {
    case "degraded":
      return 1;
    case "auth_required":
      return 2;
    default:
      return 0;
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
