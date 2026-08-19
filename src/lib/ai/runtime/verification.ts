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

export type VerificationLevel = "execution" | "artifact" | "outcome";

export type GoalVerificationSpec = {
  goal?: string;
  level?: VerificationLevel;
  requiredArtifactKinds?: string[];
  requiredMediaTypes?: string[];
  requiredTitle?: string;
  requiredPeriod?: string;
  requiredSections?: string[];
  requiredCapabilities?: string[];
  analysisOnlyAllowed?: boolean;
};

export type VerificationResult =
  | { verified: true; details?: Record<string, unknown> }
  | { verified: false; reason: string };

export interface Verifier {
  supports(target: VerificationTarget): boolean;
  verify(target: VerificationTarget): Promise<VerificationResult>;
}

export const capabilityResultVerifier: Verifier = {
  supports: (target) => target.kind === "capability_result",
  async verify(target) {
    if (target.kind !== "capability_result")
      return { verified: false, reason: "CAPABILITY_RESULT_INVALID" };
    if (!target.executed)
      return { verified: false, reason: "CAPABILITY_NOT_EXECUTED" };
    if (!nonEmptyStructuredOutput(target.value))
      return { verified: false, reason: "CAPABILITY_RESULT_EMPTY" };
    return { verified: true, details: { capability: target.capability } };
  },
};

export interface CompletionRequirement {
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
  return Object.keys(value).length > 0;
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
