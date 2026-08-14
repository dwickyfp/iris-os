import { describe, expect, it } from "vitest";
import { intersectDelegationPermissions } from "./delegation-policy";

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
});
