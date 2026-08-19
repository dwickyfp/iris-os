import { describe, expect, it } from "vitest";
import {
  intersectDelegationAuthority,
  intersectDelegationPermissions,
} from "./delegation-policy";

describe("intersectDelegationPermissions", () => {
  it("never grants a child tools missing from parent, child, or approval", () => {
    expect(
      intersectDelegationPermissions({
        parentTools: ["search", "write", "shell"],
        childTools: ["search", "shell"],
        approvedTools: ["search", "write"],
      }),
    ).toEqual(["search"]);
  });

  it("intersects tools and policy constraints without granting child authority", () => {
    expect(
      intersectDelegationAuthority({
        parentTools: ["search", "shell"],
        childTools: ["search", "unknown"],
        approvedTools: ["search", "unknown"],
        parentPolicy: {
          actions: ["read", "execute"],
          destinationKinds: ["local", "remote"],
        },
        childPolicy: {
          actions: ["read", "delete"],
          destinationKinds: ["remote", "network"],
        },
      }),
    ).toEqual({
      allowedTools: ["search"],
      policy: {
        capabilityIds: undefined,
        actions: ["read"],
        destinationKinds: ["remote"],
        maximumRisks: undefined,
      },
    });
  });
});
