export type VerificationTarget =
  | {
      kind: "artifact" | "remote_artifact";
      value: unknown;
      mediaType?: string;
      expectedUserId: string;
      expectedRunId: string;
    }
  | { kind: "tool_result"; value: unknown; mediaType?: string };

export type VerificationResult =
  | { verified: true; details?: Record<string, unknown> }
  | { verified: false; reason: string };

export interface Verifier {
  supports(target: VerificationTarget): boolean;
  verify(target: VerificationTarget): Promise<VerificationResult>;
}

export interface CompletionRequirement {
  verifyCompletion(
    value: unknown,
    expected: { userId: string; runId: string },
  ): Promise<VerificationResult>;
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
