import { createHash } from "node:crypto";
import type { FileStorage } from "lib/file-storage/file-storage.interface";
import type { VerificationResult, Verifier } from "../runtime/verification";
import { ArtifactReferenceSchema } from "./contracts";
import type { ArtifactRepository } from "./repository";

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
          result =
            sha256 === reference.sha256
              ? {
                  verified: true,
                  details: {
                    artifactId: reference.artifactId,
                    storageKey: reference.storageKey,
                    size: reference.size,
                    sha256,
                  },
                }
              : { verified: false, reason: "ARTIFACT_HASH_MISMATCH" };
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
