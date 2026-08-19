import { randomBytes } from "node:crypto";
import type { RemoteAgent } from "app-types/remote-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createRemoteAgentService } = await import("./service");

function memoryRepository(seed: RemoteAgent[] = []) {
  const rows = new Map(seed.map((agent) => [agent.id, agent]));
  return {
    rows,
    repository: {
      async listByUserId(userId: string) {
        return [...rows.values()].filter((agent) => agent.userId === userId);
      },
      async selectById(id: string, userId: string) {
        const agent = rows.get(id);
        return agent?.userId === userId ? agent : null;
      },
      async insert(
        userId: string,
        input: Omit<RemoteAgent, "id" | "userId" | "createdAt" | "updatedAt">,
      ) {
        const now = new Date("2026-08-18T00:00:00Z");
        const agent: RemoteAgent = {
          ...input,
          id: `remote-${rows.size + 1}`,
          userId,
          createdAt: now,
          updatedAt: now,
        };
        rows.set(agent.id, agent);
        return agent;
      },
      async update(id: string, userId: string, input: Partial<RemoteAgent>) {
        const agent = rows.get(id);
        if (!agent || agent.userId !== userId) return null;
        const updated = { ...agent, ...input, updatedAt: new Date() };
        rows.set(id, updated);
        return updated;
      },
      async delete(id: string, userId: string) {
        const agent = rows.get(id);
        return agent?.userId === userId ? rows.delete(id) : false;
      },
    },
  };
}

function provider() {
  return {
    discover: vi.fn(async () => ({
      name: "Remote Agent",
      url: "https://agent.example.test/rpc",
      protocolVersion: "0.3.0",
    })),
    sendTask: vi.fn(async () => ({ id: "task-1", state: "submitted" })),
    getTask: vi.fn(async () => ({ id: "task-1", state: "working" })),
    cancelTask: vi.fn(async () => ({ id: "task-1", state: "cancelled" })),
  };
}

beforeEach(() => {
  process.env.REMOTE_AGENT_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("remote agent service", () => {
  it("discovers on create, encrypts credentials, and never returns them", async () => {
    const store = memoryRepository();
    const a2a = provider();
    const service = createRemoteAgentService(
      store.repository,
      a2a as never,
      vi.fn(async (input) => ({ url: new URL(input), addresses: [] })),
    );
    const result = await service.create("user-1", {
      name: "Research",
      endpointUrl: "https://agent.example.test/a2a",
      credential: { type: "bearer", value: "private-token" },
    });

    expect(result).toMatchObject({
      userId: "user-1",
      hasCredential: true,
      credentialType: "bearer",
    });
    expect(result).not.toHaveProperty("encryptedCredential");
    expect(result).not.toHaveProperty("credentialHeader");
    const stored = store.rows.get(result.id);
    expect(stored?.encryptedCredential).not.toContain("private-token");
    expect(a2a.discover).toHaveBeenCalledWith(
      "https://agent.example.test/a2a",
      { type: "bearer", value: "private-token" },
    );
  });

  it("enforces owner isolation for reads, updates, deletes, and tasks", async () => {
    const now = new Date();
    const store = memoryRepository([
      {
        id: "remote-1",
        userId: "owner",
        name: "Owned",
        endpointUrl: "https://agent.example.test/a2a",
        status: "active",
        credentialType: null,
        credentialHeader: null,
        encryptedCredential: null,
        agentCard: {
          name: "Owned",
          url: "https://rpc.example.test/a2a",
          protocolVersion: "0.3.0",
        },
        discoveredAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const a2a = provider();
    const service = createRemoteAgentService(
      store.repository,
      a2a as never,
      vi.fn(async (input) => ({ url: new URL(input), addresses: [] })),
    );

    await expect(service.get("intruder", "remote-1")).rejects.toThrow(
      "not found",
    );
    await expect(
      service.update("intruder", "remote-1", { name: "Stolen" }),
    ).rejects.toThrow("not found");
    await expect(service.delete("intruder", "remote-1")).rejects.toThrow(
      "not found",
    );
    await expect(
      service.getTask("intruder", "remote-1", "task-1"),
    ).rejects.toThrow("not found");
    expect(a2a.getTask).not.toHaveBeenCalled();
  });

  it("uses the card URL and permits existing task operations when disabled", async () => {
    const now = new Date();
    const base: RemoteAgent = {
      id: "remote-1",
      userId: "owner",
      name: "Owned",
      endpointUrl: "https://agent.example.test/a2a",
      status: "active",
      credentialType: null,
      credentialHeader: null,
      encryptedCredential: null,
      agentCard: {
        name: "Owned",
        url: "https://rpc.example.test/a2a",
        protocolVersion: "0.3.0",
      },
      discoveredAt: now,
      createdAt: now,
      updatedAt: now,
    };
    const store = memoryRepository([base]);
    const a2a = provider();
    const service = createRemoteAgentService(
      store.repository,
      a2a as never,
      vi.fn(async (input) => ({ url: new URL(input), addresses: [] })),
    );
    await service.sendTask("owner", "remote-1", { message: { text: "hello" } });
    expect(a2a.sendTask).toHaveBeenCalledWith(
      {
        url: "https://rpc.example.test/a2a",
        version: "0.3",
        profile: "legacy-0.3-jsonrpc",
      },
      { message: { text: "hello" } },
      undefined,
    );

    store.rows.set("remote-1", { ...base, status: "disabled" });
    await expect(
      service.sendTask("owner", "remote-1", { message: { text: "new" } }),
    ).rejects.toThrow("disabled");
    await expect(
      service.getTask("owner", "remote-1", "task-1"),
    ).resolves.toMatchObject({ state: "working" });
    await expect(
      service.cancelTask("owner", "remote-1", "task-1"),
    ).resolves.toMatchObject({ state: "cancelled" });
  });
});
