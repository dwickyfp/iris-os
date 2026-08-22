import { describe, expect, test, vi } from "vitest";
import {
  capabilityResultVerifier,
  nonEmptyStructuredOutput,
  VerificationEngine,
} from "./verification";

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

  test("distinguishes an unexecuted critical capability from a result", async () => {
    await expect(
      capabilityResultVerifier.verify({
        kind: "capability_result",
        capability: "generate_report",
        executed: false,
        value: { artifact: "ignored" },
      }),
    ).resolves.toEqual({
      verified: false,
      verificationKind: "capability",
      reason: "CAPABILITY_NOT_EXECUTED",
    });
    await expect(
      capabilityResultVerifier.verify({
        kind: "capability_result",
        capability: "generate_report",
        executed: true,
        value: { artifactId: "artifact-1" },
      }),
    ).resolves.toMatchObject({
      verified: true,
      verificationKind: "capability",
    });
  });

  test("does not treat an empty runtime event as a nonempty outcome", () => {
    expect(
      nonEmptyStructuredOutput({
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "search",
        output: undefined,
      }),
    ).toBe(false);
  });
});
