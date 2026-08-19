import { findArtifactReferences, hasArtifactClaims } from "../artifacts";
import type { CompletionRequirement, VerificationResult } from "./verification";
import { VerificationEngine } from "./verification";

export class ArtifactVerificationRequirement implements CompletionRequirement {
  constructor(private readonly engine: VerificationEngine) {}

  async verifyCompletion(
    value: unknown,
    expected: { userId: string; runId: string },
  ): Promise<VerificationResult> {
    const references = findArtifactReferences(value);
    if (hasArtifactClaims(value) && references.length === 0) {
      return { verified: false, reason: "ARTIFACT_REFERENCE_INVALID" };
    }
    for (const reference of references) {
      const result = await this.engine.verify({
        kind: "artifact",
        value: reference,
        mediaType: reference.mediaType,
        expectedUserId: expected.userId,
        expectedRunId: expected.runId,
      });
      if (!result.verified) return result;
    }
    return {
      verified: true,
      details: { artifactCount: references.length },
    };
  }
}
