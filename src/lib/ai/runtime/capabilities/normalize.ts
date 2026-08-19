import type { CapabilityHints, ChatMention } from "app-types/chat";

type LegacyToolChoice = "auto" | "none" | "manual";
type ChatAutonomy = "standard" | "ask" | "off";

export type NormalizableChatRequest = {
  primaryAgentId?: string;
  capabilityHints?: CapabilityHints;
  autonomy?: ChatAutonomy;
  mentions?: ChatMention[];
  toolChoice: LegacyToolChoice;
  [key: string]: unknown;
};

const toolChoiceByAutonomy: Record<ChatAutonomy, LegacyToolChoice> = {
  standard: "auto",
  ask: "manual",
  off: "none",
};

const autonomyByToolChoice: Record<LegacyToolChoice, ChatAutonomy> = {
  auto: "standard",
  manual: "ask",
  none: "off",
};

function capabilityKey(capability: ChatMention) {
  switch (capability.type) {
    case "mcpTool":
      return `${capability.type}:${capability.serverId}:${capability.name}`;
    case "mcpServer":
      return `${capability.type}:${capability.serverId}`;
    case "workflow":
      return `${capability.type}:${capability.workflowId}`;
    case "skill":
      return `${capability.type}:${capability.skillId}`;
    case "remoteAgent":
      return `${capability.type}:${capability.agentId}`;
    case "peerAgent":
    case "agent":
      return `peerAgent:${capability.agentId}`;
    default:
      return `${capability.type}:${capability.name}`;
  }
}

/** Converts both shipped request fields and capability-domain fields to one shape. */
export function normalizeChatRequest<T extends NormalizableChatRequest>(
  request: T,
) {
  const legacyMentions = request.mentions ?? [];
  const legacyPrimary = legacyMentions.find(
    (mention) => mention.type === "agent",
  ) as Extract<ChatMention, { type: "agent" }> | undefined;
  const primaryAgentId = request.primaryAgentId ?? legacyPrimary?.agentId;
  const mode =
    request.capabilityHints?.mode ??
    (legacyMentions.some((mention) => mention.routingMode === "only")
      ? "only"
      : "prefer");
  const requested =
    request.capabilityHints?.requested ??
    legacyMentions.filter((mention) => mention.type !== "agent");

  const routedMentions: ChatMention[] = requested.map((capability) => ({
    ...capability,
    routingMode: mode,
  }));
  if (primaryAgentId) {
    routedMentions.unshift({
      type: "agent",
      agentId: primaryAgentId,
      name: legacyPrimary?.name ?? "",
      description: legacyPrimary?.description,
      icon: legacyPrimary?.icon,
      routingMode: mode,
    });
  }

  const mentions = Array.from(
    new Map(
      routedMentions.map((mention) => [capabilityKey(mention), mention]),
    ).values(),
  );
  const autonomy = request.autonomy ?? autonomyByToolChoice[request.toolChoice];

  return {
    ...request,
    primaryAgentId,
    capabilityHints: { requested, mode },
    autonomy,
    toolChoice: request.autonomy
      ? toolChoiceByAutonomy[request.autonomy]
      : request.toolChoice,
    mentions,
  };
}
