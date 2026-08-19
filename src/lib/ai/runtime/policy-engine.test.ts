import { DefaultToolName } from "lib/ai/tools";
import { describe, expect, test } from "vitest";
import {
  PolicyEngine,
  intersectPolicyAuthority,
  policyEngine,
} from "./policy-engine";

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
      version: 2,
      approvalPolicy: "destructive_only",
      authority: {
        capabilityIds: [
          `tool:${DefaultToolName.WebSearch}`,
          "tool:mcp-unclassified-tool",
        ],
      },
      capabilities: {
        [DefaultToolName.WebSearch]: {
          id: `tool:${DefaultToolName.WebSearch}`,
          key: DefaultToolName.WebSearch,
        },
        "mcp-unclassified-tool": {
          id: "tool:mcp-unclassified-tool",
          key: "mcp-unclassified-tool",
        },
      },
      tools: {
        [DefaultToolName.WebSearch]: policy.evaluateTool(
          DefaultToolName.WebSearch,
        ),
        "mcp-unclassified-tool": policy.evaluateTool("mcp-unclassified-tool"),
      },
    });
  });

  const baseInput = {
    actor: { type: "agent" as const, id: "agent-1", userId: "user-1" },
    capability: { id: "builtin:file", key: "file" },
    action: "read",
    resource: "file:/tmp/report.txt",
    args: {},
    destination: { kind: "local" as const },
    runtime: {
      kind: "foreground" as const,
      approvalPolicy: "destructive_only" as const,
      runId: "run-1",
    },
  };

  test("evaluates actor/action/resource/args/destination/runtime into an observable decision", () => {
    const decision = policy.evaluate(baseInput);
    expect(decision).toMatchObject({
      version: 2,
      result: "allow",
      risks: ["read"],
      actor: baseInput.actor,
      action: "read",
      resource: "file:/tmp/report.txt",
      destination: { kind: "local" },
      runtime: { kind: "foreground", runId: "run-1" },
    });
    expect(decision.decisionId).toMatch(/^[a-f0-9]{24}$/);
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });

  test("classifies write, destructive, network, code, and remote risk", () => {
    const decision = policy.evaluate({
      ...baseInput,
      capability: {
        id: "remote:shell",
        key: "shell",
        risks: ["code" as const],
      },
      action: "delete_and_execute",
      resource: "remote-script",
      destination: { kind: "remote", id: "peer-1" },
    });
    expect(decision.result).toBe("approval");
    expect(decision.risks).toEqual(["write", "destructive", "code", "remote"]);
  });

  test("uses destination to distinguish otherwise identical operations", () => {
    const local = policy.evaluate({
      ...baseInput,
      action: "send",
      runtime: { ...baseInput.runtime, approvalPolicy: "never" },
    });
    const network = policy.evaluate({
      ...baseInput,
      action: "send",
      destination: { kind: "network", uri: "https://example.test" },
      runtime: { ...baseInput.runtime, approvalPolicy: "never" },
    });
    expect(local.risks).toEqual(["write"]);
    expect(network.risks).toEqual(["write", "network"]);
  });

  test("trusted metadata and explicit hints cannot suppress inferred risk", () => {
    const decision = policy.evaluate({
      ...baseInput,
      capability: { id: "hinted", key: "hinted", risks: ["read"] },
      action: "delete",
      destination: { kind: "remote" },
    });
    expect(decision.risks).toEqual(["read", "destructive", "remote"]);
    expect(decision.result).toBe("approval");
  });

  test("denies authority violations even when approval is disabled", () => {
    const decision = policy.evaluate({
      ...baseInput,
      runtime: {
        ...baseInput.runtime,
        approvalPolicy: "never",
        authority: {
          capabilityIds: ["builtin:other"],
          destinationKinds: ["local"],
        },
      },
    });
    expect(decision.result).toBe("deny");
    expect(decision.reasons).toContain("capability_outside_authority");
  });

  test("child authority intersection can only reduce parent authority", () => {
    expect(
      intersectPolicyAuthority(
        {
          capabilityIds: ["search", "shell"],
          actions: ["read", "execute"],
          destinationKinds: ["local", "remote"],
          maximumRisks: ["read", "write", "code"],
        },
        {
          capabilityIds: ["search", "unknown"],
          actions: ["read", "delete"],
          destinationKinds: ["local", "network"],
          maximumRisks: ["read", "destructive"],
        },
      ),
    ).toEqual({
      capabilityIds: ["search"],
      actions: ["read"],
      destinationKinds: ["local"],
      maximumRisks: ["read"],
    });
  });
});
