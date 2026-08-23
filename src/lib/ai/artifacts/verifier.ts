import { createHash } from "node:crypto";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import type { VerificationResult, Verifier } from "../runtime/verification";
import { ArtifactReferenceSchema, extractArtifactContent } from "./contracts";
import type { ArtifactRepository } from "./repository";

export function verifyZipStructure(bytes: Buffer): boolean {
  const countCentralDirectory = (directoryOffset: number, entries: number) => {
    let position = directoryOffset;
    let counted = 0;
    while (
      position + 4 <= bytes.length &&
      bytes[position] === 0x50 &&
      bytes[position + 1] === 0x4b &&
      bytes[position + 2] === 0x01 &&
      bytes[position + 3] === 0x02
    ) {
      counted += 1;
      position += 46 + bytes.readUInt16LE(position + 28);
    }
    return counted === entries;
  };

  let offset = bytes.length - 22;
  while (offset >= 0) {
    const signatureValid =
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06;
    if (signatureValid) {
      const entries = bytes.readUInt16LE(offset + 10);
      const directorySize = bytes.readUInt32LE(offset + 12);
      const directoryOffset = bytes.readUInt32LE(offset + 16);
      if (
        directoryOffset + directorySize <= bytes.length &&
        countCentralDirectory(directoryOffset, entries)
      )
        return true;
    }
    offset -= 1;
  }
  return false;
}

export function createArtifactVerifier(
  storage: FileStorage,
  repository: ArtifactRepository,
): Verifier {
  return {
    supports: ({ kind }) => kind === "artifact" || kind === "remote_artifact",
    async verify(target): Promise<VerificationResult> {
      if (target.kind !== "artifact" && target.kind !== "remote_artifact") {
        return { verified: false, reason: "ARTIFACT_REFERENCE_INVALID" };
      }
      const { value, expectedUserId, expectedRunId } = target;
      const parsed = ArtifactReferenceSchema.safeParse(value);
      if (!parsed.success)
        return { verified: false, reason: "ARTIFACT_REFERENCE_INVALID" };
      const reference = parsed.data;
      const artifact = await repository.selectById(reference.artifactId);
      let result: VerificationResult;

      if (!artifact) {
        result = { verified: false, reason: "ARTIFACT_NOT_REGISTERED" };
      } else if (
        artifact.userId !== expectedUserId ||
        artifact.runId !== expectedRunId
      ) {
        result = { verified: false, reason: "ARTIFACT_OWNER_RUN_MISMATCH" };
      } else if (
        artifact.storageKey !== reference.storageKey ||
        artifact.filename !== reference.filename ||
        artifact.mediaType !== reference.mediaType ||
        artifact.size !== reference.size ||
        artifact.sha256 !== reference.sha256
      ) {
        result = { verified: false, reason: "ARTIFACT_REFERENCE_MISMATCH" };
      } else if (!(await storage.exists(reference.storageKey))) {
        result = { verified: false, reason: "ARTIFACT_NOT_FOUND" };
      } else {
        const metadata = await storage.getMetadata(reference.storageKey);
        if (!metadata) {
          result = { verified: false, reason: "ARTIFACT_METADATA_MISSING" };
        } else if (
          metadata.size !== reference.size ||
          metadata.contentType !== reference.mediaType
        ) {
          result = { verified: false, reason: "ARTIFACT_METADATA_MISMATCH" };
        } else {
          const bytes = await storage.download(reference.storageKey);
          const sha256 = createHash("sha256").update(bytes).digest("hex");
          const hashValid = sha256 === reference.sha256;
          const archiveValid =
            reference.mediaType !== "application/zip" ||
            verifyZipStructure(bytes);
          result =
            hashValid && archiveValid
              ? {
                  verified: true,
                  details: {
                    artifactId: reference.artifactId,
                    storageKey: reference.storageKey,
                    size: reference.size,
                    sha256,
                    content: extractArtifactContent(bytes, reference.mediaType),
                  },
                }
              : {
                  verified: false,
                  reason: !hashValid
                    ? "ARTIFACT_HASH_MISMATCH"
                    : "ARTIFACT_ARCHIVE_STRUCTURE_INVALID",
                };
        }
      }

      if (artifact) {
        await repository.recordVerification({
          artifactId: reference.artifactId,
          verified: result.verified,
          reason: result.verified ? undefined : result.reason,
          details: result.verified ? result.details : undefined,
        });
      }
      return result;
    },
  };
}
