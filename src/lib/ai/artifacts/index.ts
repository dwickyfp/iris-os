export type {
  ArtifactRecord,
  ArtifactReference,
  ArtifactVerificationRecord,
  ExtractedArtifactContent,
} from "./contracts";
export {
  ArtifactReferenceSchema,
  extractArtifactContent,
  findArtifactReferences,
  hasArtifactClaims,
} from "./contracts";
export type { ArtifactRepository } from "./repository";
export { ArtifactService } from "./service";
export { createArtifactVerifier } from "./verifier";
export { ingestRemoteArtifacts } from "./remote";
