import { describe, expect, it } from "vitest";
import {
  assertDelegationTargetEligible,
  delegationTargetId,
} from "./targets";

describe("delegation target allowlist", () => {
  it("uses stable kind-qualified target identities", () => {
    expect(delegationTargetId({ kind: "local", agentId: "agent-1" })).toBe(
      "local:agent-1",
    );
    expect(
      delegationTargetId({ kind: "remote", connectionId: "connection-1" }),
    ).toBe("remote:connection-1");
  });

  it("rejects a target absent from the parent run context", () => {
    expect(() =>
      assertDelegationTargetEligible({
        context: { eligibleDelegationTargets: ["local:agent-1"] },
        target: { kind: "local", agentId: "agent-2" },
        remoteAgentsEnabled: true,
      }),
    ).toThrow("DELEGATION_TARGET_NOT_ELIGIBLE");
  });

  it("requires the remote-agent feature flag after allowlist authorization", () => {
    expect(() =>
      assertDelegationTargetEligible({
        context: { eligibleDelegationTargets: ["remote:connection-1"] },
        target: { kind: "remote", connectionId: "connection-1" },
        remoteAgentsEnabled: false,
      }),
    ).toThrow("REMOTE_AGENTS_DISABLED");
  });

  it("allows an eligible local target", () => {
    expect(() =>
      assertDelegationTargetEligible({
        context: { eligibleDelegationTargets: ["local:agent-1"] },
        target: { kind: "local", agentId: "agent-1" },
        remoteAgentsEnabled: false,
      }),
    ).not.toThrow();
  });
});
