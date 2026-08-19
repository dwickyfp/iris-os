import { artifactRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import { ArtifactService, createArtifactVerifier } from "../../artifacts";
import { createGenerateReportTool } from "./generate-report";

const artifactVerifier = createArtifactVerifier(
  serverFileStorage,
  artifactRepository,
);

export const generateReportTool = createGenerateReportTool({
  artifacts: new ArtifactService(serverFileStorage, artifactRepository),
  verify: artifactVerifier.verify.bind(artifactVerifier),
});
