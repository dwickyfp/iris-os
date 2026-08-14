import { describe, expect, it } from "vitest";
import {
  buildRecallScopes,
  memoryScopeKey,
  resolveMemoryScope,
  type MemoryScopeOwnership,
} from "./scope";

const owner: MemoryScopeOwnership = {
  workspace: async (userId, id) => userId === "user-1" && id === "workspace-1",
  task: async (_userId, id) => id === "task-1",
  agent: async (_userId, id) => id === "agent-1",
};

describe("resolveMemoryScope", () => {
  it("normalizes an omitted scope to global", async () => {
    await expect(resolveMemoryScope("user-1", {}, owner)).resolves.toEqual({
      scopeType: "global",
      scopeId: null,
    });
  });

  it("rejects invalid type/id pairs", async () => {
    await expect(
      resolveMemoryScope(
        "user-1",
        { scopeType: "global", scopeId: "x" },
        owner,
      ),
    ).rejects.toThrow("Global memory cannot have a scopeId");
    await expect(
      resolveMemoryScope("user-1", { scopeType: "workspace" }, owner),
    ).rejects.toThrow("workspace memory requires a scopeId");
  });

  it("rejects a scope not owned by the user", async () => {
    await expect(
      resolveMemoryScope(
        "user-2",
        { scopeType: "workspace", scopeId: "workspace-1" },
        owner,
      ),
    ).rejects.toThrow("Memory scope not found");
  });

  it("produces collision-safe exact-scope keys", () => {
    expect(memoryScopeKey({ scopeType: "global", scopeId: null })).toBe(
      "global:",
    );
    expect(
      memoryScopeKey({ scopeType: "workspace", scopeId: "workspace-1" }),
    ).toBe("workspace:workspace-1");
  });

  it("builds recall precedence without including another workspace", () => {
    expect(
      buildRecallScopes({
        taskId: "task-1",
        agentId: "agent-1",
        workspaceId: "workspace-1",
      }),
    ).toEqual([
      { scopeType: "task", scopeId: "task-1" },
      { scopeType: "agent", scopeId: "agent-1" },
      { scopeType: "workspace", scopeId: "workspace-1" },
      { scopeType: "global", scopeId: null },
    ]);
  });
});
