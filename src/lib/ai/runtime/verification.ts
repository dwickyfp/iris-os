export type VerificationTarget =
  | {
      kind: "artifact" | "remote_artifact";
      value: unknown;
      mediaType?: string;
      expectedUserId: string;
      expectedRunId: string;
    }
  | { kind: "tool_result"; value: unknown; mediaType?: string }
  | {
      kind: "capability_result";
      capability: string;
      value: unknown;
      executed?: boolean;
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
    };

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
    return {
      verified: true,
      verificationKind: "capability",
      details: { capability: target.capability },
    };
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
      ].includes(key) &&
      nonEmptyStructuredOutput(item),
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

  constructor(private readonly requirements: readonly CompletionRequirement[]) {}

  async verifyCompletion(
    value: unknown,
    expected: { userId: string; runId: string },
  ): Promise<VerificationResult> {
    const checks: VerificationResult[] = [];
    for (const requirement of this.requirements) {
      const result = await requirement.verifyCompletion(value, expected);
      checks.push(result);
      if (!result.verified) return result;
    }
    return { verified: true, details: { checks } };
  }
}
