import { createHash } from "node:crypto";
import type { MemoryKind } from "app-types/memory";

const PREFIX =
  /^(?:(?:sekarang|currently)\s+)?(?:aku|saya|gue|i)\s+(?:(?:sangat|lebih|paling)\s+)?(?:tidak\s+|nggak\s+|ga\s+|gak\s+)?(?:suka|ingin|mau|prefer|love|like)\s+/i;
const NEGATION = /\b(?:tidak|nggak|gak|ga|bukan|don't|do not|dislike|hate)\b/i;

export function normalizeMemoryText(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("id-ID")
    .replace(/[“”"'`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function memoryContentHash(value: string) {
  return createHash("sha256").update(normalizeMemoryText(value)).digest("hex");
}

export function memorySubject(value: string) {
  return normalizeMemoryText(value)
    .replace(PREFIX, "")
    .replace(/\b(?:sangat|banget|sekali|sekarang|currently)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function classifyMemoryRelation(current: string, candidate: string) {
  const a = normalizeMemoryText(current);
  const b = normalizeMemoryText(candidate);
  if (a === b) return "duplicate" as const;
  const subjectA = memorySubject(current);
  const subjectB = memorySubject(candidate);
  const sameSubject =
    subjectA === subjectB ||
    (subjectA.length >= 5 &&
      subjectB.length >= 5 &&
      (subjectA.includes(subjectB) || subjectB.includes(subjectA)));
  if (sameSubject && NEGATION.test(current) !== NEGATION.test(candidate))
    return "conflict" as const;
  if (sameSubject) return "refinement" as const;
  return "new" as const;
}

export function inferMemoryTopic(kind: MemoryKind, content: string) {
  const normalized = normalizeMemoryText(content);
  if (/makan|minum|sapi|ayam|jus|kopi|teh|food|drink/.test(normalized))
    return { key: "food-drink", label: "Preferensi makanan dan minuman" };
  if (/jawab|respons|bahasa|singkat|detail|format|tone|gaya/.test(normalized))
    return { key: "communication", label: "Gaya komunikasi" };
  if (kind === "goal") return { key: "goals", label: "Tujuan" };
  if (kind === "fact") return { key: "user-facts", label: "Tentang pengguna" };
  return { key: "preferences", label: "Preferensi" };
}

export function extractEntityName(content: string) {
  return memorySubject(content).slice(0, 240);
}
