import { describe, expect, it } from "vitest";
import { CacheKeys } from "./cache-keys";

describe("CacheKeys.agentInstructions", () => {
  it("scopes cached agent access by user", () => {
    expect(CacheKeys.agentInstructions("agent-1", "user-1")).not.toBe(
      CacheKeys.agentInstructions("agent-1", "user-2"),
    );
  });
});
