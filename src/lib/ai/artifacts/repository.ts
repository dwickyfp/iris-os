import type {
  ArtifactRecord,
  ArtifactReference,
  ArtifactVerificationRecord,
} from "./contracts";

export interface ArtifactRepository {
  create(
    artifact: ArtifactReference & { userId: string; runId: string },
  ): Promise<ArtifactRecord>;
  selectById(id: string): Promise<ArtifactRecord | null>;
  recordVerification(input: {
    artifactId: string;
    verified: boolean;
    reason?: string;
    details?: Record<string, unknown>;
  }): Promise<ArtifactVerificationRecord>;
}
