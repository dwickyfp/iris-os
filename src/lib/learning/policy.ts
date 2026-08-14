import { createHash } from "node:crypto";
import type { ActivityEventType } from "app-types/activity";
import type { MemoryScopeType } from "app-types/memory";

export type LearningCandidateType = "memory" | "skill" | "automation";

export type LearningSignal = {
  candidateType: LearningCandidateType;
  observationType: "durable_statement" | "procedure_pattern" | "time_pattern";
  summary: string;
  normalizedPattern: string;
  threshold: number;
};

function normalizePattern(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s:]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isChatCorrection(text: string) {
  return /\b(koreksi|ralat|bukan begitu|jangan (?:lagi )?lakukan|ubah (?:cara|prosedur)|instead|correction)\b/i.test(
    text,
  );
}

export function procedureSimilarity(left: string, right: string) {
  const ignored = new Set([
    "koreksi",
    "ralat",
    "jangan",
    "lagi",
    "ubah",
    "cara",
    "prosedur",
    "lakukan",
    "yang",
    "untuk",
    "dengan",
  ]);
  const tokens = (value: string) =>
    new Set(
      normalizePattern(value)
        .split(" ")
        .filter((token) => token.length >= 3 && !ignored.has(token)),
    );
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.min(a.size, b.size);
}

export function extractLearningSignal(input: {
  eventType: ActivityEventType;
  payload: Record<string, unknown>;
}): LearningSignal | null {
  const text = String(input.payload.userText ?? "")
    .trim()
    .slice(0, 2_000);
  if (!text || !["chat.completed", "chat.correction"].includes(input.eventType))
    return null;
  const normalizedPattern = normalizePattern(text);
  // Time patterns are intentionally telemetry-only. Background learning must
  // never turn an inferred schedule into an executable automation.
  if (/\b(setiap|tiap|harian|mingguan|bulanan|every)\b/i.test(text)) return null;
  if (/\b(langkah|prosedur|workflow|selalu lakukan|cara untuk)\b/i.test(text))
    return {
      candidateType: "skill",
      observationType: "procedure_pattern",
      summary: text,
      normalizedPattern,
      threshold: 3,
    };
  // Durable statements are handled exclusively by the memory worker.
  return null;
}

export function canAutoPromoteSkill(input: {
  enabled: boolean;
  autonomyLevel: number;
  allowedCategories: LearningCandidateType[];
  evidenceCount: number;
  correctionCount?: number;
  successfulOutcomeCount?: number;
}) {
  return (
    input.enabled &&
    input.autonomyLevel >= 1 &&
    input.allowedCategories.includes("skill") &&
    input.evidenceCount >= 3 &&
    (input.successfulOutcomeCount ?? input.evidenceCount) >= 3 &&
    (input.correctionCount ?? 0) === 0
  );
}

export function learningSuppressionKey(input: {
  userId: string;
  scopeType: MemoryScopeType;
  scopeId: string | null;
  candidateType: LearningCandidateType;
  normalizedPattern: string;
}) {
  return createHash("sha256")
    .update(
      [
        input.userId,
        input.scopeType,
        input.scopeId ?? "global",
        input.candidateType,
        input.normalizedPattern,
      ].join(":"),
    )
    .digest("hex");
}

export function learningConfidence(
  input:
    | number
    | {
        evidenceCount: number;
        ageDays?: number;
        consistency?: number;
        correctionCount?: number;
        successfulOutcomeCount?: number;
      },
) {
  const factors = typeof input === "number" ? { evidenceCount: input } : input;
  const evidence = Math.min(5, Math.max(1, factors.evidenceCount)) * 10;
  const recency = Math.max(0, 10 - Math.max(0, factors.ageDays ?? 0));
  const consistency = Math.round(
    Math.max(0, Math.min(1, factors.consistency ?? 1)) * 15,
  );
  const outcomes = Math.min(10, (factors.successfulOutcomeCount ?? 0) * 2);
  const corrections = Math.min(30, (factors.correctionCount ?? 0) * 10);
  return Math.max(
    0,
    Math.min(
      95,
      20 + evidence + recency + consistency + outcomes - corrections,
    ),
  );
}

export function isLearningAllowed(input: {
  enabled: boolean;
  allowedScopes: MemoryScopeType[];
  allowedCategories: LearningCandidateType[];
  scopeType: MemoryScopeType;
  candidateType: LearningCandidateType;
}) {
  return (
    input.enabled &&
    input.allowedScopes.includes(input.scopeType) &&
    input.allowedCategories.includes(input.candidateType)
  );
}
