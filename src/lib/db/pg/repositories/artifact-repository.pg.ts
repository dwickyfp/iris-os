import "server-only";

import { eq } from "drizzle-orm";
import type { ArtifactRepository } from "lib/ai/artifacts";
import { pgDb as db } from "../db.pg";
import { ArtifactTable, ArtifactVerificationTable } from "../schema.pg";

export const pgArtifactRepository: ArtifactRepository = {
  async create(input) {
    const [created] = await db
      .insert(ArtifactTable)
      .values({
        id: input.artifactId,
        userId: input.userId,
        runId: input.runId,
        storageKey: input.storageKey,
        filename: input.filename,
        mediaType: input.mediaType,
        size: input.size,
        sha256: input.sha256,
      })
      .returning();
    return {
      ...created,
      artifactId: created.id,
    };
  },

  async selectById(id) {
    const [artifact] = await db
      .select()
      .from(ArtifactTable)
      .where(eq(ArtifactTable.id, id));
    return artifact ? { ...artifact, artifactId: artifact.id } : null;
  },

  async recordVerification(input) {
    const [created] = await db
      .insert(ArtifactVerificationTable)
      .values({
        artifactId: input.artifactId,
        verified: input.verified,
        reason: input.reason ?? null,
        details: input.details ?? {},
      })
      .returning();
    return created;
  },
};
