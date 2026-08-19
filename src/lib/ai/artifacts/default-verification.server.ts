import { artifactRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import { ArtifactVerificationRequirement } from "../runtime/artifact-verification-requirement";
import { VerificationEngine } from "../runtime/verification";
import { createArtifactVerifier } from "./verifier";

export function createDefaultArtifactVerificationRequirement() {
  return new ArtifactVerificationRequirement(
    new VerificationEngine([
      createArtifactVerifier(serverFileStorage, artifactRepository),
    ]),
  );
}
