import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import type { ArtifactReference } from "./contracts";
import type { ArtifactRepository } from "./repository";

export class ArtifactService {
  constructor(
    private readonly storage: FileStorage,
    private readonly repository: ArtifactRepository,
  ) {}

  async create(input: {
    content: Buffer | string;
    filename: string;
    mediaType: string;
    userId: string;
    runId: string;
  }): Promise<ArtifactReference> {
    const bytes = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `artifacts/${randomUUID()}-${path.posix.basename(input.filename)}`;
    const storageProfileId = await this.storage.getProfileId?.();
    const uploadCleanupId = await this.repository.scheduleUploadCleanup(
      storageKey,
      storageProfileId,
    );
    const uploaded = await this.storage.upload(bytes, {
      key: storageKey,
      filename: input.filename,
      contentType: input.mediaType,
      sha256,
    });
    if (uploaded.key !== storageKey)
      throw new Error("ARTIFACT_STORAGE_KEY_MISMATCH");
    const reference: ArtifactReference = {
      artifactId: randomUUID(),
      storageKey: uploaded.key,
      filename: input.filename,
      mediaType: input.mediaType,
      size: bytes.byteLength,
      sha256,
      storageProfileId,
    };

    try {
      await this.repository.create({
        ...reference,
        userId: input.userId,
        runId: input.runId,
        uploadCleanupId,
      });
    } catch (error) {
      try {
        const storage =
          reference.storageProfileId && "withProfile" in this.storage
            ? (
                this.storage as FileStorage & {
                  withProfile(id: string): FileStorage;
                }
              ).withProfile(reference.storageProfileId)
            : this.storage;
        await storage.delete(uploaded.key);
        await this.repository.completeCleanup(uploadCleanupId, new Date());
      } catch {
        // The upload cleanup intent remains pending for the reaper.
      }
      throw error;
    }
    return reference;
  }

  async discard(reference: ArtifactReference): Promise<void> {
    const cleanupId = await this.repository.scheduleCleanup(reference);
    try {
      const storage =
        reference.storageProfileId && "withProfile" in this.storage
          ? (
              this.storage as FileStorage & {
                withProfile(id: string): FileStorage;
              }
            ).withProfile(reference.storageProfileId)
          : this.storage;
      await storage.delete(reference.storageKey);
      await this.repository.completeCleanup(cleanupId, new Date());
    } catch {
      // The durable pending record is retried by the artifact cleanup reaper.
    }
  }

  async reapCleanup(
    input: { before?: Date; limit?: number } = {},
  ): Promise<number> {
    const before = input.before ?? new Date();
    const jobs = await this.repository.claimCleanup({
      before,
      limit: Math.min(Math.max(input.limit ?? 100, 1), 500),
    });
    for (const job of jobs) {
      try {
        const storage =
          job.storageProfileId && "withProfile" in this.storage
            ? (
                this.storage as FileStorage & {
                  withProfile(id: string): FileStorage;
                }
              ).withProfile(job.storageProfileId)
            : this.storage;
        await storage.delete(job.storageKey);
        await this.repository.completeCleanup(job.cleanupId, new Date());
      } catch (error) {
        const failed = job.attempts >= 10;
        await this.repository.retryCleanup({
          cleanupId: job.cleanupId,
          nextAttemptAt: new Date(
            before.getTime() + Math.min(2 ** job.attempts * 1_000, 3_600_000),
          ),
          error: error instanceof Error ? error.message : String(error),
          failed,
        });
      }
    }
    return jobs.length;
  }
}
