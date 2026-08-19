export type {
  ArtifactRecord,
  ArtifactReference,
  ArtifactVerificationRecord,
} from "./contracts";
export {
  ArtifactReferenceSchema,
  findArtifactReferences,
  hasArtifactClaims,
} from "./contracts";
export type { ArtifactRepository } from "./repository";
export { ArtifactService } from "./service";
export { createArtifactVerifier } from "./verifier";
export { ingestRemoteArtifacts } from "./remote";
