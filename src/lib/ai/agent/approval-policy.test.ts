import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import { describe, expect, it } from "vitest";
import { SKILLS_LIST_TOOL_NAME, SKILL_VIEW_TOOL_NAME } from "../skill";
import { isReadOnlyTool, requiresToolApproval } from "./approval-policy";

describe("requiresToolApproval", () => {
  it("auto-runs read-only tools", () => {
    expect(requiresToolApproval(DefaultToolName.WebSearch)).toBe(false);
    expect(requiresToolApproval(DefaultToolName.CreateTable)).toBe(false);
    expect(isReadOnlyTool(DefaultToolName.WebContent)).toBe(true);
    expect(requiresToolApproval(SKILLS_LIST_TOOL_NAME)).toBe(false);
    expect(requiresToolApproval(SKILL_VIEW_TOOL_NAME)).toBe(false);
  });

  it("requires approval for mutating and unknown tools", () => {
    expect(requiresToolApproval(DefaultToolName.PythonExecution)).toBe(true);
    expect(requiresToolApproval(ImageToolName)).toBe(true);
    expect(requiresToolApproval("mcp-unclassified-tool")).toBe(true);
  });
});
