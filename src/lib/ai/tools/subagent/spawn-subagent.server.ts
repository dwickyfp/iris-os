import { artifactRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import { ArtifactService } from "../../artifacts";
import type { LanguageModel, Tool } from "ai";
import { createSpawnSubagentTool } from "./spawn-subagent";

const artifactService = new ArtifactService(
  serverFileStorage,
  artifactRepository,
);

export function createServerSpawnSubagentTool({
  model,
  parentTools,
}: {
  model: LanguageModel;
  parentTools: Record<string, Tool>;
}) {
  return createSpawnSubagentTool({
    model,
    artifacts: artifactService,
    parentTools,
  });
}
