import {
  extractArtifactContent,
  findArtifactReferences,
  hasArtifactClaims,
} from "../artifacts";
import type {
  CompletionRequirement,
  CapabilityVerification,
  VerificationResult,
} from "./verification";
import { VerificationEngine, nonEmptyStructuredOutput } from "./verification";

function includesRequired(actual: string[], required: string[]) {
  const normalized = new Set(actual.map((item) => item.trim().toLowerCase()));
  return required.every((item) => normalized.has(item.trim().toLowerCase()));
}

function mediaTypeMatches(actual: string, required: string) {
  return required.endsWith("/*")
    ? actual.startsWith(required.slice(0, -1))
    : actual === required;
}

function artifactKindMatches(
  reference: { filename: string; mediaType: string },
  kind: string,
) {
  const normalized = kind.toLowerCase();
  const filename = reference.filename.toLowerCase();
  return (
    filename.endsWith(normalized) ||
    filename.split(".")[0] === normalized ||
    normalized === "file" ||
    (normalized === "report" &&
      (reference.mediaType === "text/markdown" ||
        reference.mediaType === "application/pdf")) ||
    (normalized === "image" && reference.mediaType.startsWith("image/"))
  );
}

function capabilityExecutions(value: unknown) {
  const executions = new Map<string, CapabilityVerification>();
  const visited = new Set<object>();
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || visited.has(candidate))
      return;
    visited.add(candidate);
    const record = candidate as Record<string, unknown>;
    const toolName =
      typeof record.toolName === "string" ? record.toolName : undefined;
    const toolCallId =
      typeof record.toolCallId === "string" ? record.toolCallId : undefined;
    if (record.type === "tool-result" && toolName && toolCallId) {
      const output =
        record.output &&
        typeof record.output === "object" &&
        (record.output as Record<string, unknown>).type === "json"
          ? (record.output as Record<string, unknown>).value
          : record.output;
      executions.set(toolName, {
        capability: toolName,
        executed: true,
        result: output,
      });
    }
    if (
      typeof record.type === "string" &&
      record.type.startsWith("tool-") &&
      toolCallId &&
      record.state === "output-available"
    ) {
      const capability = record.type.slice("tool-".length);
      executions.set(capability, {
        capability,
        executed: true,
        result: record.output,
      });
    }
    for (const nested of Array.isArray(candidate)
      ? candidate
      : Object.values(record))
      visit(nested);
  };
  visit(value);
  return executions;
}

export class CapabilityRequirement implements CompletionRequirement {
  readonly kind = "capability" as const;

  constructor(
    private readonly engine: VerificationEngine,
    private readonly capabilities: readonly string[],
  ) {}

  async verifyCompletion(
    value: unknown,
    _expected: { userId: string; runId: string },
  ): Promise<VerificationResult> {
    const executions = capabilityExecutions(value);
    for (const capability of this.capabilities) {
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
    return {
      verified: true,
      verificationKind: "capability",
      details: { capabilities: [...this.capabilities] },
    };
  }
}

export class OutcomeRequirement implements CompletionRequirement {
  readonly kind = "outcome" as const;

  async verifyCompletion(
    value: unknown,
    _expected?: { userId: string; runId: string },
  ): Promise<VerificationResult> {
    return nonEmptyStructuredOutput(value)
      ? { verified: true, verificationKind: "outcome" }
      : {
          verified: false,
          verificationKind: "outcome",
          reason: "OUTCOME_EMPTY",
        };
  }
}

export type ArtifactRequirementSpec = {
  goal?: string;
  requiredArtifactKinds?: string[];
  requiredMediaTypes?: string[];
  requiredTitle?: string;
  requiredPeriod?: string;
  requiredSections?: string[];
};

export class ArtifactRequirement implements CompletionRequirement {
  readonly kind = "artifact" as const;

  constructor(
    private readonly engine: VerificationEngine,
    private readonly spec: ArtifactRequirementSpec = {},
  ) {}

  async verifyCompletion(
    value: unknown,
    expected: { userId: string; runId: string },
  ): Promise<VerificationResult> {
    const references = findArtifactReferences(value);
    if (hasArtifactClaims(value) && references.length === 0)
      return { verified: false, reason: "ARTIFACT_REFERENCE_INVALID" };
    if (references.length === 0)
      return { verified: false, reason: "REQUIRED_ARTIFACT_MISSING" };

    const verifiedArtifacts: Array<{
      reference: (typeof references)[number];
      content?: ReturnType<typeof extractArtifactContent>;
    }> = [];
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
      verifiedArtifacts.push({ reference, content });
    }
    const matchingArtifacts = verifiedArtifacts.filter(
      ({ reference }) =>
        (!this.spec.requiredMediaTypes?.length ||
          this.spec.requiredMediaTypes.some((required) =>
            mediaTypeMatches(reference.mediaType, required),
          )) &&
        (!this.spec.requiredArtifactKinds?.length ||
          this.spec.requiredArtifactKinds.some((kind) =>
            artifactKindMatches(reference, kind),
          )),
    );
    if (
      this.spec.requiredMediaTypes?.length &&
      !verifiedArtifacts.some(({ reference }) =>
        this.spec.requiredMediaTypes?.some((required) =>
          mediaTypeMatches(reference.mediaType, required),
        ),
      )
    )
      return { verified: false, reason: "REQUIRED_MEDIA_TYPE_MISSING" };
    if (this.spec.requiredArtifactKinds?.length && !matchingArtifacts.length)
      return { verified: false, reason: "REQUIRED_ARTIFACT_KIND_MISSING" };
    const contentMatches = matchingArtifacts.map(({ content }) => content);
    if (
      this.spec.requiredTitle &&
      !contentMatches.some(
        (content) => content?.title === this.spec.requiredTitle,
      )
    )
      return { verified: false, reason: "REQUIRED_TITLE_MISSING" };
    if (
      this.spec.requiredPeriod &&
      !contentMatches.some((content) =>
        content?.text
          .toLowerCase()
          .includes(this.spec.requiredPeriod!.toLowerCase()),
      )
    )
      return { verified: false, reason: "REQUIRED_PERIOD_MISSING" };
    if (
      this.spec.requiredSections?.length &&
      !contentMatches.some(
        (content) =>
          content &&
          includesRequired(content.sections, this.spec.requiredSections!),
      )
    )
      return { verified: false, reason: "REQUIRED_SECTION_MISSING" };
    return {
      verified: true,
      verificationKind: "artifact",
      details: { goal: this.spec.goal, artifactCount: references.length },
    };
  }
}
