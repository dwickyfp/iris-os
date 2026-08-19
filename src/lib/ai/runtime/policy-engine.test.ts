import { DefaultToolName } from "lib/ai/tools";
import { describe, expect, test } from "vitest";
import { PolicyEngine, policyEngine } from "./policy-engine";

describe("PolicyEngine", () => {
  test("maps user-facing autonomy separately from capability routing", () => {
    expect(policyEngine.approvalPolicyForMode("standard")).toBe(
      "destructive_only",
    );
    expect(policyEngine.approvalPolicyForMode("ask")).toBe("always");
    expect(policyEngine.approvalPolicyForMode("off")).toBe("never");
  });
  const policy = new PolicyEngine();

  test("provides diagnostics for current read-only and fail-safe behavior", () => {
    expect(policy.evaluateTool(DefaultToolName.WebSearch)).toEqual({
      toolName: DefaultToolName.WebSearch,
      readOnly: true,
      requiresApproval: false,
      reason: "read_only",
    });
    expect(policy.evaluateTool("manage_learning")).toEqual({
      toolName: "manage_learning",
      readOnly: false,
      requiresApproval: false,
      reason: "explicit_low_risk",
    });
    expect(policy.evaluateTool("mcp-unclassified-tool")).toEqual({
      toolName: "mcp-unclassified-tool",
      readOnly: false,
      requiresApproval: true,
      reason: "unclassified",
    });
  });

  test("maps the progressive autonomy ladder to approval policy", () => {
    expect(
      [0, 1, 2, 3].map((level) => policy.approvalPolicyForAutonomy(level)),
    ).toEqual(["always", "always", "always", "always"]);
    expect(policy.approvalPolicyForAutonomy(4)).toBe("destructive_only");
    expect(() => policy.approvalPolicyForAutonomy(5)).toThrow(RangeError);
  });

  test("resolves an immutable execution policy snapshot", () => {
    expect(
      policy.resolveSnapshot(
        [DefaultToolName.WebSearch, "mcp-unclassified-tool"],
        "destructive_only",
      ),
    ).toEqual({
      approvalPolicy: "destructive_only",
      tools: {
        [DefaultToolName.WebSearch]: policy.evaluateTool(
          DefaultToolName.WebSearch,
        ),
        "mcp-unclassified-tool": policy.evaluateTool("mcp-unclassified-tool"),
      },
    });
  });
});
