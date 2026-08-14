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
  if (/\b(setiap|tiap|harian|mingguan|bulanan|every)\b/i.test(text))
    return {
      candidateType: "automation",
      observationType: "time_pattern",
      summary: text,
      normalizedPattern,
      threshold: 3,
    };
  if (/\b(langkah|prosedur|workflow|selalu lakukan|cara untuk)\b/i.test(text))
    return {
      candidateType: "skill",
      observationType: "procedure_pattern",
      summary: text,
      normalizedPattern,
      threshold: 3,
    };
  if (/\b(ingat|catat|aku|saya|gue|prefer|tolong|jangan|selalu)\b/i.test(text))
    return {
      candidateType: "memory",
      observationType: "durable_statement",
      summary: text,
      normalizedPattern,
      threshold: 1,
    };
  return null;
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
