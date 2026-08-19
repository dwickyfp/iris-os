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

export type ArtifactVerificationRecord = {
  id: string;
  artifactId: string;
  verified: boolean;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
};

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
