import { createHash } from "node:crypto";
import type { MemoryKind } from "app-types/memory";

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

export function defaultMemoryTopic(kind: MemoryKind) {
  switch (kind) {
    case "identity":
      return { key: "identity", label: "Identitas" };
    case "preference":
      return { key: "preferences.general", label: "Preferensi" };
    case "goal":
      return { key: "goals", label: "Tujuan" };
    case "relationship":
      return { key: "relationships", label: "Relasi" };
    case "decision":
      return { key: "decisions", label: "Keputusan" };
    case "procedure":
      return { key: "procedures", label: "Prosedur" };
    case "operational":
      return { key: "operations", label: "Konteks operasional" };
    default:
      return { key: "user-facts", label: "Tentang pengguna" };
  }
}
