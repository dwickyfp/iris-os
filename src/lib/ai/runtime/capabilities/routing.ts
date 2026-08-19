import type { ChatMention } from "app-types/chat";

export function capabilityRoutingMode(mentions?: ChatMention[]) {
  return mentions?.some(
    (mention) => "routingMode" in mention && mention.routingMode === "only",
  )
    ? "only"
    : "prefer";
}

export function mergePreferredCapabilities<T>(
  eligible: Record<string, T>,
  requested: Record<string, T>,
  mentions?: ChatMention[],
) {
  const requestedEligible = Object.keys(requested).reduce<Record<string, T>>(
    (result, key) => {
      if (Object.hasOwn(eligible, key)) result[key] = eligible[key];
      return result;
    },
    {},
  );
  if (capabilityRoutingMode(mentions) === "only") return requestedEligible;

  return { ...requestedEligible, ...eligible };
}
