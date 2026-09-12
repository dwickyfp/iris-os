import { chatApiSchemaRequestBodySchema } from "app-types/chat";
import { describe, expect, it } from "vitest";
import { normalizeChatRequest, resolveChatToolChoice } from "./normalize";

describe("resolveChatToolChoice", () => {
  it("autonomy overrides a conflicting client tool choice", () => {
    // This is the server-side floor: a client cannot request both bound
    // tools ("auto") and a disabled approval policy ("off").
    expect(resolveChatToolChoice("off", "auto")).toBe("none");
    expect(resolveChatToolChoice("ask", "auto")).toBe("manual");
    expect(resolveChatToolChoice("standard", "manual")).toBe("auto");
  });

  it("falls back to the requested tool choice without autonomy", () => {
    expect(resolveChatToolChoice(undefined, "manual")).toBe("manual");
    expect(resolveChatToolChoice(undefined, undefined)).toBe("auto");
  });
});

describe("normalizeChatRequest", () => {
  it("normalizes a legacy primary agent and tool mentions", () => {
    const result = normalizeChatRequest({
      toolChoice: "manual" as const,
      mentions: [
        { type: "agent" as const, agentId: "primary", name: "Primary" },
        {
          type: "defaultTool" as const,
          name: "webSearch",
          label: "Web search",
        },
      ],
    });

    expect(result.primaryAgentId).toBe("primary");
    expect(result.autonomy).toBe("ask");
    expect(result.capabilityHints).toEqual({
      requested: [
        {
          type: "defaultTool",
          name: "webSearch",
          label: "Web search",
        },
      ],
      mode: "prefer",
    });
    expect(result.mentions).toEqual([
      {
        type: "agent",
        agentId: "primary",
        name: "Primary",
        routingMode: "prefer",
      },
      {
        type: "defaultTool",
        name: "webSearch",
        label: "Web search",
        routingMode: "prefer",
      },
    ]);
  });

  it("keeps peer agents separate from primary legacy agent compatibility", () => {
    const result = normalizeChatRequest({
      toolChoice: "auto" as const,
      primaryAgentId: "primary",
      capabilityHints: {
        mode: "only" as const,
        requested: [
          { type: "peerAgent" as const, agentId: "peer", name: "Reviewer" },
        ],
      },
    });

    expect(result.primaryAgentId).toBe("primary");
    expect(result.capabilityHints.requested[0].type).toBe("peerAgent");
    expect(result.mentions).toEqual([
      {
        type: "agent",
        agentId: "primary",
        name: "",
        routingMode: "only",
      },
      {
        type: "peerAgent",
        agentId: "peer",
        name: "Reviewer",
        routingMode: "only",
      },
    ]);
  });

  it("lets modern autonomy override the legacy tool choice", () => {
    const result = normalizeChatRequest({
      toolChoice: "auto" as const,
      autonomy: "off" as const,
    });

    expect(result.toolChoice).toBe("none");
    expect(result.autonomy).toBe("off");
  });

  it("normalizes skill and remote-peer hints without identity collisions", () => {
    const result = normalizeChatRequest({
      toolChoice: "auto" as const,
      capabilityHints: {
        mode: "only" as const,
        requested: [
          { type: "skill" as const, skillId: "skill-1", name: "Review" },
          {
            type: "remoteAgent" as const,
            agentId: "remote-1",
            name: "Remote reviewer",
          },
        ],
      },
    });

    expect(result.mentions).toEqual([
      {
        type: "skill",
        skillId: "skill-1",
        name: "Review",
        routingMode: "only",
      },
      {
        type: "remoteAgent",
        agentId: "remote-1",
        name: "Remote reviewer",
        routingMode: "only",
      },
    ]);
  });

  it("accepts modern requests without legacy routing fields", () => {
    const result = chatApiSchemaRequestBodySchema.parse({
      id: "thread",
      message: { id: "message", role: "user", parts: [] },
      autonomy: "standard",
      capabilityHints: {
        requested: [],
        mode: "prefer",
      },
    });

    expect(result.toolChoice).toBe("auto");
    expect(result.mentions).toEqual([]);
  });
});
