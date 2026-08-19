import { describe, expect, it, vi } from "vitest";
import {
  builtinCapabilities,
  localPeerCapabilities,
  mcpCapabilities,
  remotePeerCapabilities,
  skillCapabilities,
  workflowCapabilities,
} from "./providers";

describe("capability providers", () => {
  it("adapts builtins and MCP tools with stable hint identities", async () => {
    const builtin = builtinCapabilities(async () => [
      { key: "search", value: "builtin" },
    ]);
    const mcp = mcpCapabilities(async () => [
      {
        key: "remoteSearch",
        serverId: "server",
        tool: { name: "search", description: "Search remotely" },
        value: "mcp",
      },
    ]);

    expect(await builtin.eligible({})).toMatchObject([
      { id: "builtin:search", key: "search", kind: "builtin" },
    ]);
    expect(await mcp.eligible({})).toMatchObject([
      {
        id: "mcp:server:search",
        key: "remoteSearch",
        kind: "mcp",
        hintIds: ["mcp-server:server"],
        description: "Search remotely",
      },
    ]);
  });

  it("uses the workflow repository's execute-ability listing", async () => {
    const selectExecuteAbility = vi.fn(async () => [
      {
        id: "workflow-1",
        name: "Publish",
        schema: { type: "object" as const, properties: {} },
        visibility: "private" as const,
        isPublished: true,
        userId: "user-1",
        userName: "User",
        updatedAt: new Date(),
      },
    ]);
    const provider = workflowCapabilities(
      { selectExecuteAbility },
      (workflow) => `execute:${workflow.id}`,
    );

    expect(await provider.eligible({ userId: "user-1" })).toMatchObject([
      {
        id: "workflow:workflow-1",
        key: "Publish",
        kind: "workflow",
        value: "execute:workflow-1",
      },
    ]);
    expect(selectExecuteAbility).toHaveBeenCalledWith("user-1");
  });

  it("adapts eligible skills and local peers", async () => {
    const now = new Date();
    const skill = skillCapabilities(
      async () => [
        {
          id: "skill-1",
          name: "Review",
          description: "Review work",
          provenance: "manual" as const,
          version: 1,
          userId: "user-1",
          visibility: "private" as const,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "archived",
          name: "Archived",
          description: "Old",
          provenance: "manual" as const,
          version: 1,
          userId: "user-1",
          visibility: "private" as const,
          archivedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      ({ id }) => id,
    );
    const peer = localPeerCapabilities(
      async () => [
        {
          id: "agent-1",
          name: "Reviewer",
          userId: "user-1",
          visibility: "private" as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
      ({ id }) => id,
    );

    expect(await skill.eligible({})).toMatchObject([
      { id: "skill:skill-1", kind: "skill" },
    ]);
    expect(await peer.eligible({})).toMatchObject([
      { id: "local-peer:agent-1", kind: "localPeer", surfaces: [] },
    ]);
  });

  it("does not load remote peers when the feature gate is disabled", async () => {
    const load = vi.fn(async () => []);
    const provider = remotePeerCapabilities({
      enabled: () => false,
      load,
      value: ({ id }) => id,
    });

    expect(await provider.eligible({})).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });

  it("includes only active remote peers when enabled", async () => {
    const now = new Date();
    const remote = (id: string, status: "active" | "disabled") => ({
      id,
      userId: "user-1",
      name: id,
      endpointUrl: `https://${id}.example.com`,
      status,
      credentialType: null,
      credentialHeader: null,
      encryptedCredential: null,
      agentCard: null,
      discoveredAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const provider = remotePeerCapabilities({
      enabled: () => true,
      load: async () => [remote("ready", "active"), remote("off", "disabled")],
      value: ({ id }) => id,
    });

    expect(await provider.eligible({})).toMatchObject([
      { id: "remote-peer:ready", kind: "remotePeer", value: "ready" },
    ]);
  });

  it("adds remote Agent Card skills and provider to search metadata", async () => {
    const now = new Date();
    const provider = remotePeerCapabilities({
      enabled: () => true,
      load: async () => [
        {
          id: "snowflake-agent",
          userId: "user-1",
          name: "Warehouse analyst",
          endpointUrl: "https://agent.example.com",
          status: "active" as const,
          credentialType: null,
          credentialHeader: null,
          encryptedCredential: null,
          agentCard: {
            name: "Finance analyst",
            provider: { organization: "Snowflake Inc" },
            skills: [
              { id: "revenue", name: "Revenue forecasting", tags: ["finance"] },
            ],
          },
          discoveredAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      value: ({ id }) => id,
    });

    expect(await provider.eligible({})).toMatchObject([
      {
        search: {
          aliases: ["Finance analyst"],
          provider: ["Snowflake Inc"],
          skills: ["revenue", "Revenue forecasting", "finance"],
        },
      },
    ]);
  });
});
