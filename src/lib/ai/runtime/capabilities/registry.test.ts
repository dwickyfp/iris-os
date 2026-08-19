import type { CapabilityHints } from "app-types/chat";
import { describe, expect, it, vi } from "vitest";
import {
  type CapabilityDescriptor,
  type CapabilityProvider,
  CapabilityRegistry,
  modelCapabilityDescriptor,
} from "./registry";

function capability(
  id: string,
  key = id,
  surfaces: CapabilityDescriptor["surfaces"] = [
    "executable",
    "model",
    "manual",
  ],
): CapabilityDescriptor {
  return {
    id,
    key,
    kind: "builtin",
    name: id,
    surfaces,
    value: `${id}-value`,
  };
}

function provider(
  name: string,
  descriptors: CapabilityDescriptor[],
): CapabilityProvider<{ userId: string }> {
  return { name, eligible: vi.fn(async () => descriptors) };
}

function hints(
  requested: CapabilityHints["requested"],
  mode: CapabilityHints["mode"] = "prefer",
): CapabilityHints {
  return { requested, mode };
}

describe("CapabilityRegistry", () => {
  it("lists eligible capabilities before intersecting untrusted hints", async () => {
    const eligible = provider("builtins", [capability("builtin:allowed")]);
    const registry = new CapabilityRegistry([eligible]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints(
        [
          {
            type: "defaultTool",
            name: "not-authorized",
            label: "Not authorized",
          },
        ],
        "only",
      ),
    );

    expect(eligible.eligible).toHaveBeenCalledWith({ userId: "user-1" });
    expect(result.ordered).toEqual([]);
    expect(result.executable).toEqual({});
  });

  it("orders preferred capabilities first without expanding eligibility", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [
        capability("builtin:first", "first"),
        capability("builtin:second", "second"),
        capability("builtin:third", "third"),
      ]),
    ]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints([
        { type: "defaultTool", name: "third", label: "Third" },
        { type: "defaultTool", name: "missing", label: "Missing" },
        { type: "defaultTool", name: "first", label: "First" },
      ]),
    );

    expect(result.ordered.map(({ key }) => key)).toEqual([
      "third",
      "first",
      "second",
    ]);
  });

  it("uses only mode as an intersection with eligible capabilities", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [
        capability("builtin:allowed", "allowed"),
        capability("builtin:other", "other"),
      ]),
    ]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints(
        [
          { type: "defaultTool", name: "allowed", label: "Allowed" },
          { type: "defaultTool", name: "missing", label: "Missing" },
        ],
        "only",
      ),
    );

    expect(result.ordered.map(({ key }) => key)).toEqual(["allowed"]);
  });

  it("hard-limits request preferences to a trusted custom-agent allowlist", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [
        capability("builtin:allowed", "allowed"),
        capability("builtin:requested", "requested"),
        capability("builtin:generate_report", "generate_report"),
      ]),
    ]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints([{ type: "defaultTool", name: "requested", label: "Requested" }]),
      [{ type: "defaultTool", name: "allowed", label: "Allowed" }],
    );

    expect(result.ordered.map(({ key }) => key)).toEqual(["allowed"]);
  });

  it("applies the hard allowlist to MCP, workflows, skills, and peers", async () => {
    const descriptors = [
      { ...capability("mcp:server-1:search", "search"), kind: "mcp" as const },
      {
        ...capability("workflow:workflow-1", "workflow"),
        kind: "workflow" as const,
      },
      {
        ...capability("skill-runtime:list", "skills"),
        kind: "skill" as const,
        hintIds: ["skill:skill-1"],
      },
      {
        ...capability("local-peer:agent-1", "local"),
        kind: "localPeer" as const,
      },
      {
        ...capability("remote-peer:agent-2", "remote"),
        kind: "remotePeer" as const,
      },
    ];
    const registry = new CapabilityRegistry([provider("mixed", descriptors)]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints([
        { type: "workflow", workflowId: "workflow-1", name: "Workflow" },
        { type: "peerAgent", agentId: "agent-1", name: "Local" },
      ]),
      [
        {
          type: "mcpTool",
          serverId: "server-1",
          name: "search",
          description: "Search",
        },
        { type: "skill", skillId: "skill-1", name: "Skill" },
        { type: "remoteAgent", agentId: "agent-2", name: "Remote" },
      ],
    );

    expect(result.ordered.map(({ key }) => key)).toEqual([
      "search",
      "skills",
      "remote",
    ]);
  });

  it("gives a custom agent with an explicit empty allowlist no capabilities", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [capability("builtin:eligible", "eligible")]),
    ]);

    const result = await registry.resolve({ userId: "user-1" }, hints([]), []);

    expect(result.ordered).toEqual([]);
    expect(result.executable).toEqual({});
  });

  it("keeps all provider-eligible capabilities for a base agent", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [
        capability("builtin:requested", "requested"),
        capability("builtin:generate_report", "generate_report"),
      ]),
    ]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints([{ type: "defaultTool", name: "requested", label: "Requested" }]),
    );

    expect(result.ordered.map(({ key }) => key)).toEqual([
      "requested",
      "generate_report",
    ]);
  });

  it("routes an allowed image tool through normal provider resolution", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [
        capability("builtin:image-manager", "image-manager"),
        capability("builtin:other", "other"),
      ]),
    ]);
    const image = {
      type: "defaultTool" as const,
      name: "image-manager",
      label: "Generate image",
    };

    const result = await registry.resolve(
      { userId: "user-1" },
      hints([image], "only"),
      [image],
    );

    expect(result.ordered.map(({ key }) => key)).toEqual(["image-manager"]);
    expect(result.model).toEqual({
      "image-manager": "builtin:image-manager-value",
    });
  });

  it("does not route an image tool outside a custom-agent allowlist", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [
        capability("builtin:image-manager", "image-manager"),
      ]),
    ]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints(
        [
          {
            type: "defaultTool",
            name: "image-manager",
            label: "Generate image",
          },
        ],
        "only",
      ),
      [],
    );

    expect(result.model).toEqual({});
  });

  it("expands an eligible MCP server hint to its eligible tools", async () => {
    const serverTool = {
      ...capability("mcp:server-1:search", "search"),
      hintIds: ["mcp-server:server-1"],
    };
    const registry = new CapabilityRegistry([
      provider("mcp", [serverTool, capability("mcp:server-2:write", "write")]),
    ]);

    const result = await registry.resolve(
      { userId: "user-1" },
      hints(
        [
          {
            type: "mcpServer",
            serverId: "server-1",
            name: "Server 1",
          },
        ],
        "only",
      ),
    );

    expect(result.ordered.map(({ id }) => id)).toEqual(["mcp:server-1:search"]);
  });

  it("removes all colliding runtime keys from every output", async () => {
    const registry = new CapabilityRegistry([
      provider("builtins", [capability("builtin:search", "search")]),
      provider("mcp", [capability("mcp:server:search", "search")]),
    ]);

    const result = await registry.resolve({ userId: "user-1" });

    expect(result.ordered).toEqual([]);
    expect(result.executable).toEqual({});
    expect(result.model).toEqual({});
    expect(result.manual).toEqual({});
    expect(result.collisions).toEqual([
      {
        key: "search",
        capabilityIds: ["builtin:search", "mcp:server:search"],
        providers: ["builtins", "mcp"],
      },
    ]);
  });

  it("builds independent executable, model, and manual maps", async () => {
    const executable = capability("builtin:execute", "execute", ["executable"]);
    const described = {
      ...capability("builtin:described", "described", ["model", "manual"]),
      modelDescriptor: { title: "For the model" },
    };
    const registry = new CapabilityRegistry([
      provider("mixed", [executable, described]),
    ]);

    const result = await registry.resolve({ userId: "user-1" });

    expect(result.executable).toEqual({ execute: "builtin:execute-value" });
    expect(result.model).toEqual({ described: { title: "For the model" } });
    expect(result.manual).toEqual({
      described: "builtin:described-value",
    });
  });

  it("creates model-only descriptors", () => {
    expect(
      modelCapabilityDescriptor({
        model: { provider: "provider", model: "model" },
        value: "runtime-model",
        descriptor: { contextWindow: 32_000 },
      }),
    ).toMatchObject({
      id: "model:provider:model",
      key: "model:provider:model",
      kind: "model",
      surfaces: ["model"],
      value: "runtime-model",
      modelDescriptor: { contextWindow: 32_000 },
    });
  });
});
