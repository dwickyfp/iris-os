import { createHash, randomUUID } from "node:crypto";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import { describe, expect, test, vi } from "vitest";
import type { ArtifactRepository } from "./repository";
import { createArtifactVerifier } from "./verifier";

const bytes = Buffer.from("verified report");
const reference = {
  artifactId: randomUUID(),
  storageKey: "reports/report.md",
  filename: "report.md",
  mediaType: "text/markdown",
  size: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const owner = { expectedUserId: randomUUID(), expectedRunId: randomUUID() };

function dependencies(downloaded = bytes) {
  const storage = {
    exists: vi.fn(async () => true),
    getMetadata: vi.fn(async () => ({
      key: reference.storageKey,
      filename: reference.filename,
      contentType: reference.mediaType,
      size: reference.size,
    })),
    download: vi.fn(async () => downloaded),
  } as unknown as FileStorage;
  const repository = {
    create: vi.fn(),
    selectById: vi.fn(async () => ({
      ...reference,
      userId: owner.expectedUserId,
      runId: owner.expectedRunId,
      status: "active" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    recordVerification: vi.fn(async (input) => ({
      id: randomUUID(),
      artifactId: input.artifactId,
      verified: input.verified,
      reason: input.reason ?? null,
      details: input.details ?? {},
      createdAt: new Date(),
    })),
  } as ArtifactRepository;
  return { storage, repository };
}

describe("artifact verifier", () => {
  test("requires structured references and verifies storage metadata and hash", async () => {
    const { storage, repository } = dependencies();
    const verifier = createArtifactVerifier(storage, repository);

    await expect(
      verifier.verify({ kind: "artifact", value: "report.md", ...owner }),
    ).resolves.toEqual({
      verified: false,
      reason: "ARTIFACT_REFERENCE_INVALID",
    });
    await expect(
      verifier.verify({ kind: "artifact", value: reference, ...owner }),
    ).resolves.toMatchObject({ verified: true });
    expect(storage.exists).toHaveBeenCalledWith(reference.storageKey);
    expect(storage.getMetadata).toHaveBeenCalledWith(reference.storageKey);
    expect(storage.download).toHaveBeenCalledWith(reference.storageKey);
    expect(repository.recordVerification).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true }),
    );
  });

  test("rejects bytes whose hash differs from the canonical reference", async () => {
    const { storage, repository } = dependencies(Buffer.from("tampered"));
    const verifier = createArtifactVerifier(storage, repository);

    await expect(
      verifier.verify({ kind: "artifact", value: reference, ...owner }),
    ).resolves.toEqual({
      verified: false,
      reason: "ARTIFACT_HASH_MISMATCH",
    });
    expect(repository.recordVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        verified: false,
        reason: "ARTIFACT_HASH_MISMATCH",
      }),
    );
  });

  test("rejects a valid artifact owned by a different user or run", async () => {
    const { storage, repository } = dependencies();
    const verifier = createArtifactVerifier(storage, repository);

    await expect(
      verifier.verify({
        kind: "artifact",
        value: reference,
        expectedUserId: randomUUID(),
        expectedRunId: owner.expectedRunId,
      }),
    ).resolves.toEqual({
      verified: false,
      reason: "ARTIFACT_OWNER_RUN_MISMATCH",
    });
    expect(storage.exists).not.toHaveBeenCalled();
  });
});
