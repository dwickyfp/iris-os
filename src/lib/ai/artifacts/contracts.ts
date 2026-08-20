import { z } from "zod";

export const ArtifactReferenceSchema = z.object({
  artifactId: z.string().uuid(),
  storageKey: z.string().min(1),
  filename: z.string().min(1),
  mediaType: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export type ArtifactRecord = ArtifactReference & {
  userId: string;
  runId: string;
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
};

export type ArtifactOutputProvenance = {
  executionId: string;
  relativePath: string;
  sha256: string;
};

export type ArtifactVerificationRecord = {
  id: string;
  artifactId: string;
  verified: boolean;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
};

export type ArtifactCleanupRecord = {
  cleanupId: string;
  artifactId?: string;
  storageKey: string;
  status: "pending" | "processing" | "retrying" | "completed" | "failed";
  attempts: number;
  nextAttemptAt: Date;
  lastError?: string;
};

export type ExtractedArtifactContent = {
  text: string;
  title?: string;
  sections: string[];
  nonEmpty: boolean;
  structured: boolean;
};

/** Cheap, deterministic metadata extraction used by goal verification. */
export function extractArtifactContent(
  bytes: Buffer | string,
  mediaType: string,
): ExtractedArtifactContent {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  if (!mediaType.includes("markdown") && !mediaType.includes("text/"))
    return {
      text,
      nonEmpty: Buffer.byteLength(text) > 0,
      structured: false,
      sections: [],
    };
  const lines = text.split(/\r?\n/);
  const title = lines
    .find((line) => /^#\s+\S/.test(line))
    ?.replace(/^#\s+/, "")
    .trim();
  const sections = lines
    .filter((line) => /^##\s+\S/.test(line))
    .map((line) => line.replace(/^##\s+/, "").trim());
  return {
    text,
    title,
    sections,
    nonEmpty: text.trim().length > 0,
    structured: Boolean(title || sections.length),
  };
}

export function findArtifactReferences(value: unknown): ArtifactReference[] {
  const found = new Map<string, ArtifactReference>();
  const visited = new Set<object>();

  const visit = (candidate: unknown) => {
    const parsed = ArtifactReferenceSchema.safeParse(candidate);
    if (parsed.success) {
      found.set(parsed.data.artifactId, parsed.data);
      return;
    }
    if (!candidate || typeof candidate !== "object" || visited.has(candidate))
      return;
    visited.add(candidate);
    for (const nested of Array.isArray(candidate)
      ? candidate
      : Object.values(candidate)) {
      visit(nested);
    }
  };

  visit(value);
  return [...found.values()];
}

export function hasArtifactClaims(value: unknown): boolean {
  const visited = new Set<object>();
  const visit = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object" || visited.has(candidate))
      return false;
    visited.add(candidate);
    if (!Array.isArray(candidate)) {
      const record = candidate as Record<string, unknown>;
      if ("artifact" in record || "artifacts" in record) return true;
    }
    return (
      Array.isArray(candidate) ? candidate : Object.values(candidate)
    ).some(visit);
  };
  return visit(value);
}
