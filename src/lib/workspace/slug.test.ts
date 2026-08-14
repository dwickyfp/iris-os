import { describe, expect, it } from "vitest";
import { workspaceSlugFromName } from "./slug";

describe("workspaceSlugFromName", () => {
  it("creates a canonical slug from a workspace name", () => {
    expect(workspaceSlugFromName("  IRIS OS V2  ")).toBe("iris-os-v2");
    expect(workspaceSlugFromName("Client — ÁCME!")).toBe("client-acme");
  });

  it("uses a safe fallback when the name has no slug characters", () => {
    expect(workspaceSlugFromName("---")).toBe("workspace");
  });
});
