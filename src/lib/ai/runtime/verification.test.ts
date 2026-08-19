import { describe, expect, test, vi } from "vitest";
import { VerificationEngine } from "./verification";

describe("VerificationEngine", () => {
  test("does not accept a filename without a storage-backed verifier", async () => {
    const engine = new VerificationEngine([]);
    await expect(
      engine.verify({
        kind: "artifact",
        value: "report.pdf",
        expectedUserId: "user-1",
        expectedRunId: "run-1",
      }),
    ).resolves.toEqual({
      verified: false,
      reason: "NO_VERIFIER",
    });
  });

  test("returns an explicit result when no verifier supports the target", async () => {
    const verify = vi.fn();
    const engine = new VerificationEngine([{ supports: () => false, verify }]);
    await expect(
      engine.verify({ kind: "tool_result", value: {} }),
    ).resolves.toEqual({ verified: false, reason: "NO_VERIFIER" });
    expect(verify).not.toHaveBeenCalled();
  });
});
