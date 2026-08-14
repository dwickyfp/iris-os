import { describe, expect, it } from "vitest";
import { rankScopedLearnedSkills } from "./scoped-ranking";

describe("rankScopedLearnedSkills", () => {
  const rows = [
    {
      id: "global",
      name: "release-checklist",
      description: "Review release checklist",
      scopeType: "global" as const,
      scopeId: null,
    },
    {
      id: "workspace",
      name: "workspace-release",
      description: "Review release checklist",
      scopeType: "workspace" as const,
      scopeId: "workspace-1",
    },
    {
      id: "other",
      name: "other-release",
      description: "Review release checklist",
      scopeType: "workspace" as const,
      scopeId: "workspace-2",
    },
  ];

  it("prefers exact scoped skills and retains global fallback", () => {
    expect(
      rankScopedLearnedSkills(rows, {
        query: "review the release checklist",
        workspaceId: "workspace-1",
      }).map(({ id }) => id),
    ).toEqual(["workspace", "global"]);
  });

  it("does not inject unrelated or cross-workspace skills", () => {
    expect(
      rankScopedLearnedSkills(rows, {
        query: "summarize customer feedback",
        workspaceId: "workspace-1",
      }),
    ).toEqual([]);
  });
});
