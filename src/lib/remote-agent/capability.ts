import type { CapabilityRef } from "app-types/chat";
import type { PublicRemoteAgent } from "app-types/remote-agent";

export function remoteAgentCapabilityRef(
  agent: PublicRemoteAgent,
): Extract<CapabilityRef, { type: "remoteAgent" }> {
  return {
    type: "remoteAgent",
    name: agent.agentCard?.name || agent.name,
    agentId: agent.id,
    description:
      agent.agentCard?.description || `Remote agent at ${agent.endpointUrl}`,
  };
}
