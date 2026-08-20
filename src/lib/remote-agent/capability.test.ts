import { describe, expect, it } from "vitest";
import { remoteAgentCapabilityRef } from "./capability";

describe("remoteAgentCapabilityRef", () => {
  it("persists the remote connection id, not the card name", () => {
    const ref = remoteAgentCapabilityRef({
      id: "connection-1",
      userId: "user-1",
      name: "Configured name",
      endpointUrl: "https://peer.example.test/a2a",
      status: "active",
      credentialType: "bearer",
      agentCard: {
        name: "Card name",
        description: "Does remote work",
        preferredTransport: "JSON-RPC",
        skills: [{ id: "search", name: "Search" }],
      },
      discoveredAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      hasCredential: true,
    });

    expect(ref).toEqual({
      type: "remoteAgent",
      name: "Card name",
      agentId: "connection-1",
      description: "Does remote work",
    });
  });
});
