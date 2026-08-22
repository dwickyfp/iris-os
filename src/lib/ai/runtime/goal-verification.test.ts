import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  ArtifactRequirement,
  CapabilityRequirement,
  OutcomeRequirement,
} from "./artifact-verification-requirement";
import { VerificationEngine } from "./verification";

const reference = {
  artifactId: randomUUID(),
  storageKey: "reports/q1.md",
  filename: "q1.md",
  mediaType: "text/markdown",
  size: Buffer.byteLength("# Q1 Report\n\n## Summary\n\nQ1 2026"),
  sha256: createHash("sha256")
    .update("# Q1 Report\n\n## Summary\n\nQ1 2026")
    .digest("hex"),
};

const expected = { userId: "u", runId: "r" };

describe("completion requirements", () => {
  test("rejects a fake capability claim without a runtime execution event", async () => {
    const requirement = new CapabilityRequirement(
      new VerificationEngine([]),
      ["generate_report"],
    );

    await expect(
      requirement.verifyCompletion(
        {
          text: "I ran generate_report",
          capabilityResults: [
            {
              capability: "generate_report",
              executed: true,
              result: { artifactId: "fake" },
            },
          ],
        },
        expected,
      ),
    ).resolves.toEqual({
      verified: false,
      reason: "REQUIRED_CAPABILITY_NOT_EXECUTED",
    });
  });

  test("accepts a successful runtime capability result even with an empty result", async () => {
    const verifier = {
      supports: (target: { kind: string }) =>
        target.kind === "capability_result",
      verify: vi.fn(async () => ({
        verified: true as const,
        verificationKind: "capability" as const,
      })),
    };
    const requirement = new CapabilityRequirement(
      new VerificationEngine([verifier]),
      ["generate_report"],
    );

    await expect(
      requirement.verifyCompletion(
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "generate_report",
          output: undefined,
        },
        expected,
      ),
    ).resolves.toMatchObject({
      verified: true,
      verificationKind: "capability",
    });
  });

  test("rejects a terminal runtime capability failure", async () => {
    const requirement = new CapabilityRequirement(
      new VerificationEngine([
        {
          supports: (target) => target.kind === "capability_result",
          verify: async (target) =>
            target.kind === "capability_result" && target.successful
              ? { verified: true as const }
              : {
                  verified: false as const,
                  reason: "CAPABILITY_EXECUTION_FAILED",
                },
        },
      ]),
      ["generate_report"],
    );

    await expect(
      requirement.verifyCompletion(
        {
          type: "tool-generate_report",
          toolCallId: "call-1",
          state: "output-error",
          errorText: "provider failed",
        },
        expected,
      ),
    ).resolves.toEqual({
      verified: false,
      reason: "CAPABILITY_EXECUTION_FAILED",
    });
  });

  test("accepts nonempty outcome output and rejects empty output", async () => {
    const requirement = new OutcomeRequirement();

    await expect(
      requirement.verifyCompletion({ parts: [{ type: "text", text: "Answer" }] }, expected),
    ).resolves.toEqual({ verified: true, verificationKind: "outcome" });
    await expect(
      requirement.verifyCompletion({ parts: [], role: "assistant" }, expected),
    ).resolves.toEqual({
      verified: false,
      verificationKind: "outcome",
      reason: "OUTCOME_EMPTY",
    });
  });

  test("requires a canonical artifact and validates it through the engine", async () => {
    const verify = vi.fn(async () => ({
      verified: true as const,
      details: {
        content: {
          text: "# Q1 Report\n\n## Summary\n\nQ1 2026",
          title: "Q1 Report",
          sections: ["Summary"],
        },
      },
    }));
    const requirement = new ArtifactRequirement(
      new VerificationEngine([{ supports: () => true, verify }]),
      {
        requiredArtifactKinds: ["report"],
        requiredMediaTypes: ["text/markdown"],
        requiredTitle: "Q1 Report",
        requiredPeriod: "Q1 2026",
        requiredSections: ["Summary"],
      },
    );

    await expect(
      requirement.verifyCompletion({ artifact: reference }, expected),
    ).resolves.toMatchObject({ verified: true });
    expect(verify).toHaveBeenCalledWith({
      kind: "artifact",
      value: reference,
      mediaType: "text/markdown",
      expectedUserId: "u",
      expectedRunId: "r",
    });
    await expect(
      requirement.verifyCompletion({ artifact: "q1.md" }, expected),
    ).resolves.toEqual({
      verified: false,
      reason: "ARTIFACT_REFERENCE_INVALID",
    });
  });
});
