import "server-only";

import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { ArtifactRepository } from "lib/ai/artifacts";
import { pgDb as db } from "../db.pg";
import {
  ArtifactCleanupTable,
  ArtifactTable,
  ArtifactVerificationTable,
} from "../schema.pg";

export const pgArtifactRepository: ArtifactRepository = {
  async create(input) {
    return db.transaction(async (tx) => {
      const [created] = await tx
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
          outputExecutionId: input.outputProvenance?.executionId,
          outputRelativePath: input.outputProvenance?.relativePath,
        })
        .returning();
      if (input.uploadCleanupId) {
        const enrolled = await tx
          .update(ArtifactCleanupTable)
          .set({
            artifactId: created.id,
            status: "completed",
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(ArtifactCleanupTable.id, input.uploadCleanupId),
              eq(ArtifactCleanupTable.storageKey, input.storageKey),
            ),
          )
          .returning({ id: ArtifactCleanupTable.id });
        if (enrolled.length !== 1)
          throw new Error("ARTIFACT_UPLOAD_CLEANUP_NOT_FOUND");
      }
      return { ...created, artifactId: created.id };
    });
  },

  async selectById(id) {
    const [artifact] = await db
      .select()
      .from(ArtifactTable)
      .where(eq(ArtifactTable.id, id));
    return artifact ? { ...artifact, artifactId: artifact.id } : null;
  },

  async selectByOutputProvenance(input) {
    const [artifact] = await db
      .select()
      .from(ArtifactTable)
      .where(
        and(
          eq(ArtifactTable.outputExecutionId, input.executionId),
          eq(ArtifactTable.outputRelativePath, input.relativePath),
          eq(ArtifactTable.sha256, input.sha256),
          eq(ArtifactTable.status, "active"),
        ),
      );
    return artifact ? { ...artifact, artifactId: artifact.id } : null;
  },

  async archive(id) {
    await db
      .update(ArtifactTable)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(ArtifactTable.id, id));
  },

  async scheduleUploadCleanup(storageKey) {
    const [cleanup] = await db
      .insert(ArtifactCleanupTable)
      .values({
        storageKey,
        nextAttemptAt: new Date(Date.now() + 15 * 60_000),
      })
      .returning({ id: ArtifactCleanupTable.id });
    return cleanup.id;
  },

  async scheduleCleanup(reference) {
    return db.transaction(async (tx) => {
      const [artifact] = await tx
        .select({ storageKey: ArtifactTable.storageKey })
        .from(ArtifactTable)
        .where(eq(ArtifactTable.id, reference.artifactId))
        .for("update");
      if (!artifact) throw new Error("ARTIFACT_CLEANUP_NOT_FOUND");
      if (artifact.storageKey !== reference.storageKey)
        throw new Error("ARTIFACT_CLEANUP_STORAGE_KEY_MISMATCH");
      const [cleanup] = await tx
        .insert(ArtifactCleanupTable)
        .values({
          artifactId: reference.artifactId,
          storageKey: artifact.storageKey,
        })
        .onConflictDoUpdate({
          target: ArtifactCleanupTable.artifactId,
          set: {
            storageKey: artifact.storageKey,
            status: "pending",
            nextAttemptAt: new Date(),
            claimedAt: null,
            lastError: null,
            completedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning({ id: ArtifactCleanupTable.id });
      await tx
        .update(ArtifactTable)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(
            eq(ArtifactTable.id, reference.artifactId),
            eq(ArtifactTable.storageKey, reference.storageKey),
          ),
        );
      if (!cleanup) throw new Error("ARTIFACT_CLEANUP_SCHEDULE_FAILED");
      return cleanup.id;
    });
  },

  async claimCleanup({ before, limit }) {
    return db.transaction(async (tx) => {
      const jobs = await tx
        .select()
        .from(ArtifactCleanupTable)
        .where(
          or(
            and(
              inArray(ArtifactCleanupTable.status, ["pending", "retrying"]),
              lte(ArtifactCleanupTable.nextAttemptAt, before),
              isNull(ArtifactCleanupTable.claimedAt),
            ),
            and(
              eq(ArtifactCleanupTable.status, "processing"),
              lte(
                ArtifactCleanupTable.claimedAt,
                new Date(before.getTime() - 300_000),
              ),
            ),
          ),
        )
        .orderBy(ArtifactCleanupTable.nextAttemptAt)
        .limit(limit)
        .for("update", { skipLocked: true });
      if (jobs.length === 0) return [];
      const ids = jobs.map((job) => job.id);
      await tx
        .update(ArtifactCleanupTable)
        .set({
          status: "processing",
          claimedAt: before,
          attempts: sql`${ArtifactCleanupTable.attempts} + 1`,
          updatedAt: before,
        })
        .where(inArray(ArtifactCleanupTable.id, ids));
      return jobs.map((job) => ({
        cleanupId: job.id,
        artifactId: job.artifactId ?? undefined,
        storageKey: job.storageKey,
        status: "processing" as const,
        attempts: job.attempts + 1,
        nextAttemptAt: job.nextAttemptAt,
        lastError: job.lastError ?? undefined,
      }));
    });
  },

  async completeCleanup(cleanupId, completedAt) {
    await db
      .update(ArtifactCleanupTable)
      .set({
        status: "completed",
        completedAt,
        claimedAt: null,
        lastError: null,
        updatedAt: completedAt,
      })
      .where(eq(ArtifactCleanupTable.id, cleanupId));
  },

  async retryCleanup(input) {
    await db
      .update(ArtifactCleanupTable)
      .set({
        status: input.failed ? "failed" : "retrying",
        nextAttemptAt: input.nextAttemptAt,
        claimedAt: null,
        lastError: input.error.slice(0, 4_000),
        updatedAt: new Date(),
      })
      .where(eq(ArtifactCleanupTable.id, input.cleanupId));
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
