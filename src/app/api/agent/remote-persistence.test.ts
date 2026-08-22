import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  agent: null as any,
  insert: vi.fn(async (agent: any) => {
    state.agent = { ...agent, id: "agent-1" };
    return state.agent;
  }),
  select: vi.fn(async () => state.agent),
  update: vi.fn(async (_id: string, _userId: string, update: any) => {
    state.agent = { ...state.agent, ...update };
    return state.agent;
  }),
}));

vi.mock("auth/server", () => ({
  getSession: async () => ({ user: { id: "user-1" } }),
}));
vi.mock("lib/auth/permissions", () => ({
  canCreateAgent: async () => true,
  canEditAgent: async () => true,
  canDeleteAgent: async () => true,
}));
vi.mock("lib/cache", () => ({ serverCache: { delete: vi.fn() } }));
vi.mock("lib/db/repository", () => ({
  agentRepository: {
    insertAgent: state.insert,
    selectAgentById: state.select,
    updateAgent: state.update,
    checkAccess: async () => true,
  },
}));

import { GET, PUT } from "./[id]/route";
import { POST } from "./route";

const params = { params: Promise.resolve({ id: "agent-1" }) };

describe("Agent Builder remote peer persistence", () => {
  beforeEach(() => {
    state.agent = null;
    vi.clearAllMocks();
  });

  it("persists remote mentions/capabilities across create, update, and reload without secrets", async () => {
    const remote = {
      type: "remoteAgent" as const,
      agentId: "remote-1",
      name: "Research peer",
      description: "Remote research",
      credential: { type: "bearer", value: "must-not-persist" },
      encryptedCredential: "must-not-persist",
    };
    const create = await POST(
      new Request("http://localhost/api/agent", {
        method: "POST",
        body: JSON.stringify({
          userId: "spoofed-user",
          name: "Research agent",
          instructions: { mentions: [remote], capabilities: [remote] },
        }),
      }),
    );

    expect(create.status).toBe(200);
    expect(state.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        instructions: {
          mentions: [
            {
              type: "remoteAgent",
              agentId: "remote-1",
              name: "Research peer",
              description: "Remote research",
            },
          ],
          capabilities: [
            {
              type: "remoteAgent",
              agentId: "remote-1",
              name: "Research peer",
              description: "Remote research",
            },
          ],
        },
      }),
    );
    expect(JSON.stringify(await create.json())).not.toContain(
      "must-not-persist",
    );

    await PUT(
      new Request("http://localhost/api/agent/agent-1", {
        method: "PUT",
        body: JSON.stringify({
          instructions: {
            mentions: [{ ...remote, name: "Updated research peer" }],
            capabilities: [{ ...remote, name: "Updated research peer" }],
          },
        }),
      }),
      params,
    );
    const reload = await GET(
      new Request("http://localhost/api/agent/agent-1"),
      params,
    );
    const reloaded = await reload.json();

    expect(reloaded.instructions.mentions[0]).toEqual({
      type: "remoteAgent",
      agentId: "remote-1",
      name: "Updated research peer",
      description: "Remote research",
    });
    expect(reloaded.instructions.capabilities[0]).toEqual(
      reloaded.instructions.mentions[0],
    );
    expect(JSON.stringify(reloaded)).not.toContain("must-not-persist");
  });
});
