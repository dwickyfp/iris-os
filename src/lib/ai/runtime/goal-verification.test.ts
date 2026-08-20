import { createHash, randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { GoalAwareVerificationRequirement } from "./artifact-verification-requirement";
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

function makeRequirement(
  spec: ConstructorParameters<typeof GoalAwareVerificationRequirement>[1],
  value = reference,
) {
  const verifier = {
    supports: () => true,
    verify: vi.fn(async () => ({
      verified: true as const,
      details: {
        content: {
          text: "# Q1 Report\n\n## Summary\n\nQ1 2026",
          title: "Q1 Report",
          sections: ["Summary"],
          nonEmpty: true,
          structured: true,
        },
      },
    })),
  };
  return {
    requirement: new GoalAwareVerificationRequirement(
      new VerificationEngine([verifier]),
      spec,
    ),
    value: { artifact: value },
    verify: verifier.verify,
  };
}

describe("goal-aware verification", () => {
  test("does not accept model-said-done without a required report", async () => {
    const { requirement } = makeRequirement({
      goal: "Produce a report",
      level: "artifact",
      requiredArtifactKinds: ["report"],
    });
    await expect(
      requirement.verifyCompletion(
        { text: "Done" },
        { userId: "u", runId: "r" },
      ),
    ).resolves.toEqual({
      verified: false,
      reason: "REQUIRED_ARTIFACT_MISSING",
    });
  });

  test("blocks a requested goal when its output is missing", async () => {
    const { requirement } = makeRequirement({
      goal: "create Q2 revenue PDF report",
      level: "artifact",
      requiredArtifactKinds: ["report"],
      requiredMediaTypes: ["application/pdf"],
      requiredPeriod: "Q2",
      requiredCapabilities: ["analysis", "generate_report"],
    });
    await expect(
      requirement.verifyCompletion(
        { text: "I analyzed the revenue and finished the report." },
        { userId: "u", runId: "r" },
      ),
    ).resolves.toEqual({
      verified: false,
      reason: "REQUIRED_ARTIFACT_MISSING",
    });
  });

  test("checks report title, period, and sections without an LLM", async () => {
    const { requirement, verify } = makeRequirement({
      goal: "Produce Q1 report",
      level: "outcome",
      requiredArtifactKinds: ["report"],
      requiredMediaTypes: ["text/markdown"],
      requiredTitle: "Q1 Report",
      requiredPeriod: "Q1 2026",
      requiredSections: ["Summary"],
    });
    await expect(
      requirement.verifyCompletion(
        { artifact: reference },
        { userId: "u", runId: "r" },
      ),
    ).resolves.toMatchObject({ verified: true });
    expect(verify).toHaveBeenCalledOnce();
  });

  test("rejects malformed artifact claims", async () => {
    const { requirement } = makeRequirement({
      level: "artifact",
      requiredArtifactKinds: ["report"],
    });
    await expect(
      requirement.verifyCompletion(
        { artifact: "q1.md" },
        { userId: "u", runId: "r" },
      ),
    ).resolves.toEqual({
      verified: false,
      reason: "ARTIFACT_REFERENCE_INVALID",
    });
  });

  test("allows explicitly permitted analysis-only outcomes", async () => {
    const { requirement } = makeRequirement({
      goal: "Analyze trends",
      level: "outcome",
      requiredArtifactKinds: ["report"],
      analysisOnlyAllowed: true,
    });
    await expect(
      requirement.verifyCompletion(
        { text: "Analysis complete" },
        { userId: "u", runId: "r" },
      ),
    ).resolves.toEqual({ verified: true });
  });
});
