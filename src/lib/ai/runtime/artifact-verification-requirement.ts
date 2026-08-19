import {
  extractArtifactContent,
  findArtifactReferences,
  hasArtifactClaims,
} from "../artifacts";
import type {
  CompletionRequirement,
  CapabilityVerification,
  GoalVerificationSpec,
  VerificationResult,
} from "./verification";
import { VerificationEngine, nonEmptyStructuredOutput } from "./verification";

function includesRequired(actual: string[], required: string[]) {
  const normalized = new Set(actual.map((item) => item.trim().toLowerCase()));
  return required.every((item) => normalized.has(item.trim().toLowerCase()));
}

export class GoalAwareVerificationRequirement implements CompletionRequirement {
  constructor(
    private readonly engine: VerificationEngine,
    private readonly spec: GoalVerificationSpec,
  ) {}

  async verifyCompletion(
    value: unknown,
    expected: { userId: string; runId: string },
  ): Promise<VerificationResult> {
    const level = this.spec.level ?? "outcome";
    if (level === "execution" && !nonEmptyStructuredOutput(value))
      return { verified: false, reason: "EXECUTION_OUTPUT_EMPTY" };
    if (
      level === "outcome" &&
      !nonEmptyStructuredOutput(value) &&
      !this.spec.analysisOnlyAllowed
    )
      return { verified: false, reason: "OUTCOME_EMPTY" };

    const references = findArtifactReferences(value);
    if (hasArtifactClaims(value) && references.length === 0)
      return { verified: false, reason: "ARTIFACT_REFERENCE_INVALID" };
    if (this.spec.requiredArtifactKinds?.length && references.length === 0) {
      if (this.spec.analysisOnlyAllowed && level === "outcome")
        return { verified: true };
      return { verified: false, reason: "REQUIRED_ARTIFACT_MISSING" };
    }
    const verifiedArtifacts: ReturnType<typeof extractArtifactContent>[] = [];
    const executions = new Map<string, CapabilityVerification>();
    if (value && typeof value === "object") {
      const candidate = value as Record<string, unknown>;
      const raw = Array.isArray(candidate.capabilityResults)
        ? candidate.capabilityResults
        : [];
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const execution = item as Record<string, unknown>;
        if (typeof execution.capability === "string")
          executions.set(execution.capability, {
            capability: execution.capability,
            executed: execution.executed === true,
            result: execution.result,
          });
      }
    }
    for (const capability of this.spec.requiredCapabilities ?? []) {
      const execution = executions.get(capability);
      if (!execution)
        return { verified: false, reason: "REQUIRED_CAPABILITY_NOT_EXECUTED" };
      const result = await this.engine.verify({
        kind: "capability_result",
        capability,
        executed: execution.executed,
        value: execution.result,
      });
      if (!result.verified) return result;
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
      const content = result.details?.content as
        | ReturnType<typeof extractArtifactContent>
        | undefined;
      if (content) verifiedArtifacts.push(content);
      if (
        this.spec.requiredMediaTypes?.length &&
        !this.spec.requiredMediaTypes.includes(reference.mediaType)
      )
        return { verified: false, reason: "REQUIRED_MEDIA_TYPE_MISSING" };
      if (
        this.spec.requiredArtifactKinds?.length &&
        !this.spec.requiredArtifactKinds.some((kind) => {
          const normalized = kind.toLowerCase();
          const filename = reference.filename.toLowerCase();
          return (
            filename.endsWith(normalized) ||
            filename.split(".")[0] === normalized ||
            (normalized === "report" && reference.mediaType === "text/markdown")
          );
        })
      )
        return { verified: false, reason: "REQUIRED_ARTIFACT_KIND_MISSING" };
    }
    const content = verifiedArtifacts[0] as
      | ReturnType<typeof extractArtifactContent>
      | undefined;
    if (this.spec.requiredTitle && content?.title !== this.spec.requiredTitle)
      return { verified: false, reason: "REQUIRED_TITLE_MISSING" };
    if (
      this.spec.requiredPeriod &&
      (!content ||
        !content.text
          .toLowerCase()
          .includes(this.spec.requiredPeriod.toLowerCase()))
    )
      return { verified: false, reason: "REQUIRED_PERIOD_MISSING" };
    if (
      this.spec.requiredSections?.length &&
      (!content ||
        !includesRequired(content.sections, this.spec.requiredSections))
    )
      return { verified: false, reason: "REQUIRED_SECTION_MISSING" };
    if (level === "artifact" && references.length === 0)
      return { verified: false, reason: "REQUIRED_ARTIFACT_MISSING" };
    return {
      verified: true,
      details: { goal: this.spec.goal, artifactCount: references.length },
    };
  }
}

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
