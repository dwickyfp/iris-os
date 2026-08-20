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
    if (Array.isArray(record.capabilityResults)) {
      for (const item of record.capabilityResults) {
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
    const toolName =
      typeof record.toolName === "string" ? record.toolName : undefined;
    if (record.type === "tool-result" && toolName) {
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
  if (nonEmptyStructuredOutput(value) && !executions.has("analysis"))
    executions.set("analysis", {
      capability: "analysis",
      executed: true,
      result: value,
    });
  return executions;
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
    const verifiedArtifacts: Array<{
      reference: (typeof references)[number];
      content?: ReturnType<typeof extractArtifactContent>;
    }> = [];
    const executions = capabilityExecutions(value);
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
