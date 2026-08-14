import { describe, expect, it } from "vitest";
import {
  buildWorkspaceInstructionsPrompt,
  resolveThreadWorkspaceId,
} from "./context";

describe("resolveThreadWorkspaceId", () => {
  it("keeps the stored scope authoritative for an existing thread", () => {
    expect(
      resolveThreadWorkspaceId({
        threadExists: true,
        storedWorkspaceId: null,
        requestedWorkspaceId: "workspace-client-request",
      }),
    ).toBeUndefined();

    expect(
      resolveThreadWorkspaceId({
        threadExists: true,
        storedWorkspaceId: "workspace-stored",
        requestedWorkspaceId: "workspace-client-request",
      }),
    ).toBe("workspace-stored");
  });

  it("accepts requested scope only while creating a thread", () => {
    expect(
      resolveThreadWorkspaceId({
        threadExists: false,
        storedWorkspaceId: null,
        requestedWorkspaceId: "workspace-new",
      }),
    ).toBe("workspace-new");
  });
});

describe("buildWorkspaceInstructionsPrompt", () => {
  it("returns no prompt when the workspace has no instructions", () => {
    expect(
      buildWorkspaceInstructionsPrompt({
        id: "workspace-1",
        name: "IRIS",
      }),
    ).toBe("");
  });

  it("marks workspace instructions as trusted configuration", () => {
    const prompt = buildWorkspaceInstructionsPrompt({
      id: "workspace-1",
      name: "IRIS-OS",
      instructions: "Use pnpm and preserve existing architecture.",
    });

    expect(prompt).toContain("Trusted workspace configuration: IRIS-OS");
    expect(prompt).toContain("Use pnpm and preserve existing architecture.");
    expect(prompt).toContain("current user request takes precedence");
  });
});
