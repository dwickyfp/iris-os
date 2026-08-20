import { createHash, randomUUID } from "node:crypto";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import { describe, expect, test, vi } from "vitest";
import type { ArtifactRecord } from "./contracts";
import type { ArtifactRepository } from "./repository";
import { ArtifactService } from "./service";

const bytes = Buffer.from("trusted bytes");
const artifact = {
  artifactId: randomUUID(),
  storageKey: "artifact/trusted.txt",
  filename: "trusted.txt",
  mediaType: "text/plain",
  size: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  userId: randomUUID(),
  runId: randomUUID(),
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function service(overrides: Partial<ArtifactRecord> = {}, content = bytes) {
  const record = { ...artifact, ...overrides };
  const storage = {
    getMetadata: vi.fn(async () => ({
      key: record.storageKey,
      filename: record.filename,
      contentType: record.mediaType,
      size: record.size,
    })),
    download: vi.fn(async () => content),
  } as unknown as FileStorage;
  const repository = {
    scheduleUploadCleanup: vi.fn(async () => randomUUID()),
    selectById: vi.fn(async () => record),
  } as unknown as ArtifactRepository;
  return { artifacts: new ArtifactService(storage, repository), storage };
}

describe("ArtifactService sandbox input resolution", () => {
  test("authorizes owner and source run and verifies source bytes", async () => {
    const { artifacts } = service();
    await expect(
      artifacts.resolveForSandboxInput({
        artifactId: artifact.artifactId,
        userId: artifact.userId,
        sourceRunId: artifact.runId,
      }),
    ).resolves.toMatchObject({ bytes });
  });

  test("rejects ownership, inactive status, and tampered bytes", async () => {
    await expect(
      service().artifacts.resolveForSandboxInput({
        artifactId: artifact.artifactId,
        userId: randomUUID(),
        sourceRunId: artifact.runId,
      }),
    ).rejects.toThrow("SANDBOX_ARTIFACT_OWNER_RUN_MISMATCH");
    await expect(
      service({ status: "archived" }).artifacts.resolveForSandboxInput({
        artifactId: artifact.artifactId,
        userId: artifact.userId,
        sourceRunId: artifact.runId,
      }),
    ).rejects.toThrow("SANDBOX_ARTIFACT_NOT_ACTIVE");
    await expect(
      service({}, Buffer.from("tampered")).artifacts.resolveForSandboxInput({
        artifactId: artifact.artifactId,
        userId: artifact.userId,
        sourceRunId: artifact.runId,
      }),
    ).rejects.toThrow("SANDBOX_ARTIFACT_BYTES_MISMATCH");
  });
});

describe("ArtifactService cleanup", () => {
  test("records cleanup before deletion and is idempotent", async () => {
    const order: string[] = [];
    const storage = {
      delete: vi.fn(async () => {
        order.push("delete");
      }),
    } as unknown as FileStorage;
    const repository = {
      scheduleCleanup: vi.fn(async () => {
        order.push("schedule");
        return "cleanup-1";
      }),
      completeCleanup: vi.fn(async () => {
        order.push("complete");
      }),
    } as unknown as ArtifactRepository;
    const artifacts = new ArtifactService(storage, repository);

    await artifacts.discard(artifact);
    await artifacts.discard(artifact);

    expect(order).toEqual([
      "schedule",
      "delete",
      "complete",
      "schedule",
      "delete",
      "complete",
    ]);
  });

  test("retains failed deletion for a successful retry", async () => {
    const storage = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new Error("storage unavailable"))
        .mockResolvedValueOnce(undefined),
    } as unknown as FileStorage;
    const repository = {
      scheduleCleanup: vi.fn(async () => "cleanup-1"),
      claimCleanup: vi.fn(async () => [
        {
          cleanupId: "cleanup-1",
          artifactId: artifact.artifactId,
          storageKey: artifact.storageKey,
          status: "processing" as const,
          attempts: 1,
          nextAttemptAt: new Date(0),
        },
      ]),
      retryCleanup: vi.fn(async () => undefined),
      completeCleanup: vi.fn(async () => undefined),
    } as unknown as ArtifactRepository;
    const artifacts = new ArtifactService(storage, repository);

    await expect(artifacts.discard(artifact)).resolves.toBeUndefined();
    expect(repository.scheduleCleanup).toHaveBeenCalledBefore(
      vi.mocked(storage.delete),
    );
    expect(repository.completeCleanup).not.toHaveBeenCalled();

    await expect(
      artifacts.reapCleanup({ before: new Date(1_000), limit: 1 }),
    ).resolves.toBe(1);
    expect(repository.completeCleanup).toHaveBeenCalledWith(
      "cleanup-1",
      expect.any(Date),
    );
    expect(repository.retryCleanup).not.toHaveBeenCalled();
  });

  test("backs off and records retry failures", async () => {
    const storage = {
      delete: vi.fn(async () => {
        throw new Error("still unavailable");
      }),
    } as unknown as FileStorage;
    const repository = {
      claimCleanup: vi.fn(async () => [
        {
          cleanupId: "cleanup-1",
          artifactId: artifact.artifactId,
          storageKey: artifact.storageKey,
          status: "processing" as const,
          attempts: 2,
          nextAttemptAt: new Date(0),
        },
      ]),
      retryCleanup: vi.fn(async () => undefined),
    } as unknown as ArtifactRepository;

    await new ArtifactService(storage, repository).reapCleanup({
      before: new Date(1_000),
      limit: 1,
    });

    expect(repository.retryCleanup).toHaveBeenCalledWith({
      cleanupId: "cleanup-1",
      nextAttemptAt: new Date(5_000),
      error: "still unavailable",
      failed: false,
    });
  });

  test("retries an orphan when artifact creation and immediate deletion fail", async () => {
    const cleanupId = randomUUID();
    const storage = {
      upload: vi.fn(async (_content, options) => ({
        key: options.key,
        sourceUrl: "https://storage.test/artifact",
        metadata: {},
      })),
      delete: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    } as unknown as FileStorage;
    const repository = {
      scheduleUploadCleanup: vi.fn(async () => cleanupId),
      create: vi.fn(async () => {
        throw new Error("artifact insert failed");
      }),
      claimCleanup: vi.fn(async () => [
        {
          cleanupId,
          storageKey: "pending-key",
          status: "processing" as const,
          attempts: 1,
          nextAttemptAt: new Date(0),
        },
      ]),
      retryCleanup: vi.fn(async () => undefined),
    } as unknown as ArtifactRepository;
    const artifacts = new ArtifactService(storage, repository);

    await expect(
      artifacts.create({
        content: bytes,
        filename: "orphan.txt",
        mediaType: "text/plain",
        userId: artifact.userId,
        runId: artifact.runId,
      }),
    ).rejects.toThrow("artifact insert failed");

    expect(repository.scheduleUploadCleanup).toHaveBeenCalledBefore(
      vi.mocked(storage.upload),
    );
    expect(repository.claimCleanup).not.toHaveBeenCalled();
    await artifacts.reapCleanup({ before: new Date(1_000), limit: 1 });
    expect(repository.retryCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ cleanupId, error: "storage unavailable" }),
    );
  });
});
