import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import type {
  ArtifactOutputProvenance,
  ArtifactRecord,
  ArtifactReference,
} from "./contracts";
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
    outputProvenance?: ArtifactOutputProvenance;
  }): Promise<ArtifactReference> {
    const bytes = Buffer.isBuffer(input.content)
      ? input.content
      : Buffer.from(input.content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `artifacts/${randomUUID()}-${path.posix.basename(input.filename)}`;
    const uploadCleanupId =
      await this.repository.scheduleUploadCleanup(storageKey);
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
    };

    try {
      await this.repository.create({
        ...reference,
        userId: input.userId,
        runId: input.runId,
        outputProvenance: input.outputProvenance,
        uploadCleanupId,
      });
    } catch (error) {
      try {
        await this.storage.delete(uploaded.key);
        await this.repository.completeCleanup(uploadCleanupId, new Date());
      } catch {
        // The upload cleanup intent remains pending for the reaper.
      }
      throw error;
    }
    return reference;
  }

  async resolveForSandboxInput(input: {
    artifactId: string;
    userId: string;
    sourceRunId: string;
  }): Promise<{ artifact: ArtifactRecord; bytes: Buffer }> {
    const artifact = await this.repository.selectById(input.artifactId);
    if (!artifact) throw new Error("SANDBOX_ARTIFACT_NOT_FOUND");
    if (
      artifact.userId !== input.userId ||
      artifact.runId !== input.sourceRunId
    ) {
      throw new Error("SANDBOX_ARTIFACT_OWNER_RUN_MISMATCH");
    }
    if (artifact.status !== "active") {
      throw new Error("SANDBOX_ARTIFACT_NOT_ACTIVE");
    }

    const metadata = await this.storage.getMetadata(artifact.storageKey);
    if (
      !metadata ||
      metadata.size !== artifact.size ||
      metadata.contentType !== artifact.mediaType
    ) {
      throw new Error("SANDBOX_ARTIFACT_METADATA_MISMATCH");
    }
    const bytes = await this.storage.download(artifact.storageKey);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.size || sha256 !== artifact.sha256) {
      throw new Error("SANDBOX_ARTIFACT_BYTES_MISMATCH");
    }
    return { artifact, bytes };
  }

  async findOutput(
    provenance: ArtifactOutputProvenance,
  ): Promise<ArtifactRecord | null> {
    return this.repository.selectByOutputProvenance(provenance);
  }

  async discard(reference: ArtifactReference): Promise<void> {
    const cleanupId = await this.repository.scheduleCleanup(reference);
    try {
      await this.storage.delete(reference.storageKey);
      await this.repository.completeCleanup(cleanupId, new Date());
    } catch {
      // The durable pending record is retried by the sandbox cleanup reaper.
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
        await this.storage.delete(job.storageKey);
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
