import { createHash } from "node:crypto";

export type StrategyGuardLevel = 1 | 2 | 3 | 4;

export type StrategyGuardAttempt = {
  capabilityId: string;
  args: unknown;
  result: unknown;
  evidence?: readonly string[];
  progress?: readonly string[];
  requirements?: readonly string[];
};

export type StrategyGuardFingerprint = {
  capabilityId: string;
  argsHash: string;
  action: string;
  result: string;
  evidence: string[];
  progress: string[];
  requirements: string[];
};

export type StrategyGuardReason =
  | "initial_strategy"
  | "user_steer"
  | "different_capability"
  | "different_action"
  | "different_result"
  | "new_evidence"
  | "new_progress"
  | "new_requirement"
  | "exact_duplicate";

export type StrategyGuardDecision = {
  action: "allow" | "correct" | "stop";
  level: StrategyGuardLevel;
  reason: StrategyGuardReason;
  fingerprint: StrategyGuardFingerprint;
  duplicateCount: number;
  signals: {
    exactActionDuplicate: boolean;
    exactResultDuplicate: boolean;
    newEvidence: string[];
    newProgress: string[];
    newRequirements: string[];
  };
  corrective: null | {
    code:
      | "change_arguments_or_strategy"
      | "change_capability"
      | "stop_repeating";
    repeatedAction: string;
    repeatedResult: string;
    requirement: string;
  };
};

export type StrategyGuardInput = {
  attempt: StrategyGuardAttempt;
  history?: readonly StrategyGuardAttempt[];
  userSteer?: boolean;
};

type Normalized =
  | null
  | boolean
  | number
  | string
  | Normalized[]
  | { [key: string]: Normalized };

function normalizeValue(value: unknown, ancestors: Set<object>): Normalized {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $number: "NaN" };
    if (value === Infinity) return { $number: "Infinity" };
    if (value === -Infinity) return { $number: "-Infinity" };
    if (Object.is(value, -0)) return { $number: "-0" };
    return value;
  }
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "undefined") return { $undefined: "" };
  if (typeof value === "symbol" || typeof value === "function")
    throw new TypeError(`Cannot fingerprint ${typeof value} values`);

  if (ancestors.has(value))
    throw new TypeError("Cannot fingerprint a cyclic value");
  ancestors.add(value);

  let normalized: Normalized;
  if (Array.isArray(value)) {
    normalized = value.map((entry) => normalizeValue(entry, ancestors));
  } else if (value instanceof Date) {
    normalized = { $date: value.toISOString() };
  } else {
    const object = value as Record<string, unknown>;
    normalized = Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, normalizeValue(object[key], ancestors)]),
    );
  }

  ancestors.delete(value);
  return normalized;
}

export function stableNormalize(value: unknown): string {
  return JSON.stringify(normalizeValue(value, new Set()));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableNormalize(value)).digest("hex");
}

function normalizeSignals(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

export function fingerprintStrategyAttempt(
  attempt: StrategyGuardAttempt,
): StrategyGuardFingerprint {
  const argsHash = stableHash(attempt.args);
  return {
    capabilityId: attempt.capabilityId,
    argsHash,
    action: stableHash({ capabilityId: attempt.capabilityId, argsHash }),
    result: stableHash(attempt.result),
    evidence: normalizeSignals(attempt.evidence),
    progress: normalizeSignals(attempt.progress),
    requirements: normalizeSignals(attempt.requirements),
  };
}

function difference(current: readonly string[], previous: Set<string>) {
  return current.filter((value) => !previous.has(value));
}

function allowed(
  reason: Exclude<StrategyGuardReason, "exact_duplicate">,
  fingerprint: StrategyGuardFingerprint,
  signals: StrategyGuardDecision["signals"],
): StrategyGuardDecision {
  return {
    action: "allow",
    level: 1,
    reason,
    fingerprint,
    duplicateCount: 0,
    signals,
    corrective: null,
  };
}

export class StrategyGuard {
  evaluate(input: StrategyGuardInput): StrategyGuardDecision {
    const fingerprint = fingerprintStrategyAttempt(input.attempt);
    const history = (input.userSteer ? [] : (input.history ?? [])).map(
      fingerprintStrategyAttempt,
    );
    const previous = history.at(-1);
    const knownEvidence = new Set(history.flatMap((item) => item.evidence));
    const knownProgress = new Set(history.flatMap((item) => item.progress));
    const knownRequirements = new Set(
      history.flatMap((item) => item.requirements),
    );
    const newEvidence = difference(fingerprint.evidence, knownEvidence);
    const newProgress = difference(fingerprint.progress, knownProgress);
    const newRequirements = difference(
      fingerprint.requirements,
      knownRequirements,
    );
    const signals = {
      exactActionDuplicate: previous?.action === fingerprint.action,
      exactResultDuplicate: previous?.result === fingerprint.result,
      newEvidence,
      newProgress,
      newRequirements,
    };

    if (input.userSteer) return allowed("user_steer", fingerprint, signals);
    if (!previous) return allowed("initial_strategy", fingerprint, signals);
    if (previous.capabilityId !== fingerprint.capabilityId)
      return allowed("different_capability", fingerprint, signals);
    if (!signals.exactActionDuplicate)
      return allowed("different_action", fingerprint, signals);
    if (!signals.exactResultDuplicate)
      return allowed("different_result", fingerprint, signals);
    if (newEvidence.length > 0)
      return allowed("new_evidence", fingerprint, signals);
    if (newProgress.length > 0)
      return allowed("new_progress", fingerprint, signals);
    if (newRequirements.length > 0)
      return allowed("new_requirement", fingerprint, signals);

    let duplicateCount = 1;
    for (let index = history.length - 1; index > 0; index -= 1) {
      const current = history[index];
      const prior = history[index - 1];
      if (
        current.action !== fingerprint.action ||
        current.result !== fingerprint.result ||
        current.evidence.some((value) => !prior.evidence.includes(value)) ||
        current.progress.some((value) => !prior.progress.includes(value)) ||
        current.requirements.some(
          (value) => !prior.requirements.includes(value),
        )
      )
        break;
      duplicateCount += 1;
    }

    const level = Math.min(duplicateCount, 4) as StrategyGuardLevel;
    const code =
      level === 1
        ? "change_arguments_or_strategy"
        : level < 4
          ? "change_capability"
          : "stop_repeating";
    return {
      action: level === 4 ? "stop" : "correct",
      level,
      reason: "exact_duplicate",
      fingerprint,
      duplicateCount,
      signals,
      corrective: {
        code,
        repeatedAction: fingerprint.action,
        repeatedResult: fingerprint.result,
        requirement:
          level === 1
            ? "Change the arguments or strategy before retrying."
            : level < 4
              ? "Use a different capability or provide new evidence, progress, or requirements."
              : "Stop this strategy; repeated execution is not permitted.",
      },
    };
  }
}

export const strategyGuard = new StrategyGuard();
