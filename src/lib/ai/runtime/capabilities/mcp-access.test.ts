import { describe, expect, test, vi } from "vitest";
import {
  accessibleMcpServerIdsForUser,
  filterToolsByAccessibleServers,
  selectAccessibleMcpServers,
} from "./mcp-access";

describe("selectAccessibleMcpServers", () => {
  test("keeps allowlisted servers the user can access", () => {
    const accessible = new Set(["owned", "public"]);
    expect(
      selectAccessibleMcpServers(
        {
          owned: { tools: ["a", "b"] },
          public: { tools: ["c"] },
        },
        accessible,
      ),
    ).toEqual({
      owned: { tools: ["a", "b"] },
      public: { tools: ["c"] },
    });
  });

  test("drops allowlisted servers outside the accessible set", () => {
    const accessible = new Set(["owned"]);
    expect(
      selectAccessibleMcpServers(
        {
          owned: { tools: ["a"] },
          "someone-elses-private": { tools: ["secret"] },
        },
        accessible,
      ),
    ).toEqual({ owned: { tools: ["a"] } });
  });

  test("treats an absent allowlist as nothing authorized", () => {
    expect(selectAccessibleMcpServers(undefined, new Set(["owned"]))).toEqual(
      {},
    );
  });
});

describe("filterToolsByAccessibleServers", () => {
  test("removes tools bound to inaccessible servers", () => {
    const tools = {
      owned_query: { _mcpServerId: "owned" },
      leaked_query: { _mcpServerId: "someone-elses-private" },
    };
    expect(filterToolsByAccessibleServers(tools, new Set(["owned"]))).toEqual({
      owned_query: { _mcpServerId: "owned" },
    });
  });
});

describe("accessibleMcpServerIdsForUser", () => {
  test("collects ids from the ownership loader", async () => {
    const load = vi.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const ids = await accessibleMcpServerIdsForUser("user-1", load);
    expect(load).toHaveBeenCalledWith("user-1");
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  test("an empty ownership list means no server is bindable", async () => {
    const ids = await accessibleMcpServerIdsForUser(
      "user-1",
      vi.fn().mockResolvedValue([]),
    );
    expect(ids.size).toBe(0);
  });
});
