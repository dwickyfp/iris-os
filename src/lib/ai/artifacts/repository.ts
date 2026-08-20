import type {
  ArtifactCleanupRecord,
  ArtifactOutputProvenance,
  ArtifactRecord,
  ArtifactReference,
  ArtifactVerificationRecord,
} from "./contracts";

export interface ArtifactRepository {
  create(
    artifact: ArtifactReference & {
      userId: string;
      runId: string;
      outputProvenance?: ArtifactOutputProvenance;
      uploadCleanupId?: string;
    },
  ): Promise<ArtifactRecord>;
  selectById(id: string): Promise<ArtifactRecord | null>;
  selectByOutputProvenance(
    provenance: ArtifactOutputProvenance,
  ): Promise<ArtifactRecord | null>;
  archive(id: string): Promise<void>;
  scheduleUploadCleanup(storageKey: string): Promise<string>;
  scheduleCleanup(reference: ArtifactReference): Promise<string>;
  claimCleanup(input: {
    before: Date;
    limit: number;
  }): Promise<ArtifactCleanupRecord[]>;
  completeCleanup(cleanupId: string, completedAt: Date): Promise<void>;
  retryCleanup(input: {
    cleanupId: string;
    nextAttemptAt: Date;
    error: string;
    failed: boolean;
  }): Promise<void>;
  recordVerification(input: {
    artifactId: string;
    verified: boolean;
    reason?: string;
    details?: Record<string, unknown>;
  }): Promise<ArtifactVerificationRecord>;
}
