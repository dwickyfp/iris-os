export type VerificationTarget =
  | {
      kind: "artifact" | "remote_artifact";
      value: unknown;
      mediaType?: string;
      expectedUserId: string;
      expectedRunId: string;
    }
  | {
      kind: "tool_result";
      value: unknown;
      successful?: boolean;
      mediaType?: string;
    }
  | {
      kind: "capability_result";
      capability: string;
      value: unknown;
      executed?: boolean;
      successful?: boolean;
    };

export type VerificationLevel = "artifact" | "outcome";

/** Read compatibility for completion snapshots persisted before Phase 3. */
export type PersistedVerificationLevel = VerificationLevel | "execution";

export type GoalVerificationSpec = {
  goal?: string;
  level?: PersistedVerificationLevel;
  requiredArtifactKinds?: string[];
  requiredMediaTypes?: string[];
  requiredTitle?: string;
  requiredPeriod?: string;
  requiredSections?: string[];
  requiredCapabilities?: string[];
  analysisOnlyAllowed?: boolean;
};

export type VerificationResult =
  | {
      verified: true;
      verificationKind?: "capability" | "outcome" | "artifact";
      details?: Record<string, unknown>;
    }
  | {
      verified: false;
      verificationKind?: "capability" | "outcome" | "artifact";
      reason: string;
      details?: Record<string, unknown>;
    };

const RECOVERABLE_VERIFICATION_REASONS = new Set([
  "OUTCOME_EMPTY",
  "REQUIRED_CAPABILITY_NOT_EXECUTED",
  "CAPABILITY_EXECUTION_FAILED",
  "REQUIRED_ARTIFACT_MISSING",
  "REQUIRED_MEDIA_TYPE_MISSING",
  "REQUIRED_ARTIFACT_KIND_MISSING",
  "REQUIRED_TITLE_MISSING",
  "REQUIRED_PERIOD_MISSING",
  "REQUIRED_SECTION_MISSING",
  "ARTIFACT_REFERENCE_INVALID",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_HASH_MISMATCH",
]);

export class VerificationRequiredError extends Error {
  readonly code = "VERIFICATION_REQUIRED";

  constructor(readonly checks: VerificationResult[]) {
    const failed = checks.find((check) => !check.verified);
    super(
      `VERIFICATION_REQUIRED:${
        failed && !failed.verified ? failed.reason : "UNKNOWN"
      }`,
    );
  }
}

export function isRecoverableVerificationFailure(
  checks: readonly VerificationResult[],
) {
  const expanded = checks.flatMap((check) => {
    const nested = check.details?.checks;
    return Array.isArray(nested)
      ? [check, ...(nested as VerificationResult[])]
      : [check];
  });
  const failed = expanded.filter((check) => !check.verified);
  return (
    failed.length > 0 &&
    failed.every((check) => RECOVERABLE_VERIFICATION_REASONS.has(check.reason))
  );
}

export interface Verifier {
  supports(target: VerificationTarget): boolean;
  verify(target: VerificationTarget): Promise<VerificationResult>;
}

export const capabilityResultVerifier: Verifier = {
  supports: (target) => target.kind === "capability_result",
  async verify(target) {
    if (target.kind !== "capability_result")
      return {
        verified: false,
        verificationKind: "capability",
        reason: "CAPABILITY_RESULT_INVALID",
      };
    if (!target.executed)
      return {
        verified: false,
        verificationKind: "capability",
        reason: "CAPABILITY_NOT_EXECUTED",
      };
    if (!target.successful)
      return {
        verified: false,
        verificationKind: "capability",
        reason: "CAPABILITY_EXECUTION_FAILED",
      };
    return {
      verified: true,
      verificationKind: "capability",
      details: { capability: target.capability },
    };
  },
};

export const toolResultVerifier: Verifier = {
  supports: (target) => target.kind === "tool_result",
  async verify(target) {
    if (target.kind !== "tool_result" || !target.successful)
      return {
        verified: false,
        verificationKind: "capability",
        reason: "TOOL_RESULT_NOT_SUCCESSFUL",
      };
    return { verified: true, verificationKind: "capability" };
  },
};

export interface CompletionRequirement {
  readonly kind?: "capability" | "outcome" | "artifact" | "all";
  verifyCompletion(
    value: unknown,
    expected: { userId: string; runId: string },
  ): Promise<VerificationResult>;
}

export type CapabilityVerification = {
  capability: string;
  executed: boolean;
  successful: boolean;
  result?: unknown;
};

export function nonEmptyStructuredOutput(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(nonEmptyStructuredOutput);
  const record = value as Record<string, unknown>;
  if (record.type === "text") return nonEmptyStructuredOutput(record.text);
  if (record.type === "tool-result")
    return nonEmptyStructuredOutput(record.output);
  if (
    typeof record.type === "string" &&
    record.type.startsWith("tool-") &&
    record.state === "output-available"
  )
    return nonEmptyStructuredOutput(record.output);
  if (Array.isArray(record.parts))
    return record.parts.some(nonEmptyStructuredOutput);
  return Object.entries(record).some(
    ([key, item]) =>
      ![
        "id",
        "role",
        "type",
        "state",
        "toolName",
        "toolCallId",
        "input",
        "usage",
        "finishReason",
      ].includes(key) && nonEmptyStructuredOutput(item),
  );
}

export class VerificationEngine {
  constructor(private readonly verifiers: readonly Verifier[]) {}

  async verify(target: VerificationTarget): Promise<VerificationResult> {
    const verifier = this.verifiers.find((candidate) =>
      candidate.supports(target),
    );
    if (!verifier) return { verified: false, reason: "NO_VERIFIER" };
    return verifier.verify(target);
  }
}

export class AllRequirements implements CompletionRequirement {
  readonly kind = "all" as const;

  constructor(
    private readonly requirements: readonly CompletionRequirement[],
  ) {}

  async verifyCompletion(
    value: unknown,
    expected: { userId: string; runId: string },
  ): Promise<VerificationResult> {
    const checks: VerificationResult[] = [];
    for (const requirement of this.requirements) {
      const result = await requirement.verifyCompletion(value, expected);
      checks.push(result);
      if (!result.verified) continue;
    }
    const failed = checks.find((check) => !check.verified);
    return failed
      ? { ...failed, details: { checks } }
      : { verified: true, details: { checks } };
  }
}
