import { artifactRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import {
  ArtifactVerificationRequirement,
  GoalAwareVerificationRequirement,
} from "../runtime/artifact-verification-requirement";
import type { NormalizedGoalRequirement } from "../runtime/goal-requirement-resolver";
import {
  capabilityResultVerifier,
  VerificationEngine,
} from "../runtime/verification";
import { createArtifactVerifier } from "./verifier";

export function createDefaultArtifactVerificationRequirement() {
  return new ArtifactVerificationRequirement(
    new VerificationEngine([
      createArtifactVerifier(serverFileStorage, artifactRepository),
      capabilityResultVerifier,
    ]),
  );
}

export function createGoalVerificationRequirement(
  spec: NormalizedGoalRequirement,
) {
  return new GoalAwareVerificationRequirement(
    new VerificationEngine([
      createArtifactVerifier(serverFileStorage, artifactRepository),
      capabilityResultVerifier,
    ]),
    spec,
  );
}
