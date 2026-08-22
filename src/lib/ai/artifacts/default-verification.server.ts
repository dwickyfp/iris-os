import { artifactRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import {
  ArtifactRequirement,
  CapabilityRequirement,
  OutcomeRequirement,
} from "../runtime/artifact-verification-requirement";
import type { NormalizedGoalRequirement } from "../runtime/goal-requirement-resolver";
import {
  capabilityResultVerifier,
  toolResultVerifier,
  AllRequirements,
  VerificationEngine,
} from "../runtime/verification";
import { createArtifactVerifier } from "./verifier";

export function createDefaultArtifactVerificationRequirement() {
  return new ArtifactRequirement(
    new VerificationEngine([
      createArtifactVerifier(serverFileStorage, artifactRepository),
      capabilityResultVerifier,
      toolResultVerifier,
    ]),
  );
}

export function createGoalVerificationRequirement(
  spec: NormalizedGoalRequirement,
) {
  const engine = new VerificationEngine([
    createArtifactVerifier(serverFileStorage, artifactRepository),
    capabilityResultVerifier,
    toolResultVerifier,
  ]);
  return new AllRequirements([
    new OutcomeRequirement(),
    ...(spec.requiredCapabilities.length
      ? [new CapabilityRequirement(engine, spec.requiredCapabilities)]
      : []),
    ...(spec.level === "artifact"
      ? [new ArtifactRequirement(engine, spec)]
      : []),
  ]);
}
