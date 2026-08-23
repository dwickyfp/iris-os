import { createHash, randomUUID } from "node:crypto";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import { describe, expect, test, vi } from "vitest";
import type { ArtifactRepository } from "./repository";
import { createArtifactVerifier, verifyZipStructure } from "./verifier";

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
    selectByOutputProvenance: vi.fn(async () => null),
    archive: vi.fn(async () => undefined),
    recordVerification: vi.fn(async (input) => ({
      id: randomUUID(),
      artifactId: input.artifactId,
      verified: input.verified,
      reason: input.reason ?? null,
      details: input.details ?? {},
      createdAt: new Date(),
    })),
  } as unknown as ArtifactRepository;
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

  test("validates ZIP central-directory structure", () => {
    expect(verifyZipStructure(Buffer.from("not a zip"))).toBe(false);
    const zip = Buffer.alloc(100);
    zip.writeUInt32LE(0x04034b50, 0);
    const directoryOffset = 30;
    zip.writeUInt32LE(0x02014b50, directoryOffset);
    zip.writeUInt16LE(1, directoryOffset + 10);
    const eocd = 76;
    zip.writeUInt32LE(0x06054b50, eocd);
    zip.writeUInt16LE(1, eocd + 8);
    zip.writeUInt16LE(1, eocd + 10);
    zip.writeUInt32LE(46, eocd + 12);
    zip.writeUInt16LE(0, eocd + 14);
    zip.writeUInt32LE(directoryOffset, eocd + 16);
    zip.writeUInt32LE(directoryOffset, eocd + 20);
    expect(verifyZipStructure(zip)).toBe(true);
    zip.writeUInt16LE(2, eocd + 10);
    expect(verifyZipStructure(zip)).toBe(false);
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

  test("extracts deterministic Markdown title and sections into verification details", async () => {
    const { storage, repository } = dependencies();
    const verifier = createArtifactVerifier(storage, repository);
    await expect(
      verifier.verify({ kind: "artifact", value: reference, ...owner }),
    ).resolves.toMatchObject({
      verified: true,
      details: { content: { title: undefined, sections: [], nonEmpty: true } },
    });
  });
});
