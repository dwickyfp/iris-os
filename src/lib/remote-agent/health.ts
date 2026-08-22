import type { CapabilityHealth } from "app-types/capability-health";
import type { RemoteAgent } from "app-types/remote-agent";

export const REMOTE_AGENT_CARD_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

type RemoteAgentHealthInput = Pick<
  RemoteAgent,
  | "status"
  | "agentCard"
  | "discoveredAt"
  | "credentialType"
  | "encryptedCredential"
>;

export function remoteAgentHealth(
  agent: RemoteAgentHealthInput,
  options: { now?: Date; staleAfterMs?: number } = {},
): CapabilityHealth {
  if (agent.status === "disabled") {
    return { status: "disabled", reason: "connection_disabled" };
  }

  if (!agent.agentCard || !agent.discoveredAt) {
    return { status: "unavailable", reason: "agent_card_unavailable" };
  }

  const checkedAt = agent.discoveredAt.toISOString();
  const requiresCredential = cardRequiresCredential(agent.agentCard);
  if (
    requiresCredential &&
    (!agent.credentialType || !agent.encryptedCredential)
  ) {
    return {
      status: "auth_required",
      reason: "credential_required",
      checkedAt,
      metadata: { source: "cached_discovery" },
    };
  }

  const now = options.now ?? new Date();
  const staleAfterMs = options.staleAfterMs ?? REMOTE_AGENT_CARD_STALE_AFTER_MS;
  const ageMs = Math.max(0, now.getTime() - agent.discoveredAt.getTime());
  if (ageMs > staleAfterMs) {
    return {
      status: "degraded",
      reason: "agent_card_stale",
      checkedAt,
      metadata: { source: "cached_discovery", ageMs, staleAfterMs },
    };
  }

  return {
    status: "healthy",
    checkedAt,
    metadata: { source: "cached_discovery", ageMs, staleAfterMs },
  };
}

function cardRequiresCredential(card: Record<string, unknown>) {
  const security = card.security;
  return Array.isArray(security) && security.length > 0;
}
