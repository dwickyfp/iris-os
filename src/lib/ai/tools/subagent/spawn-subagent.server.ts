import { artifactRepository } from "lib/db/repository";
import { serverFileStorage } from "lib/file-storage";
import { ArtifactService } from "../../artifacts";
import type { AgentRuntimeContext } from "../../agent/runtime-context";
import type { LanguageModel, Tool } from "ai";
import { createSpawnSubagentTool } from "./spawn-subagent";

const artifactService = new ArtifactService(
  serverFileStorage,
  artifactRepository,
);

export function createServerSpawnSubagentTool({
  model,
  runtimeContext,
  parentTools,
}: {
  model: LanguageModel;
  runtimeContext: AgentRuntimeContext;
  parentTools: Record<string, Tool>;
}) {
  return createSpawnSubagentTool({
    model,
    runtimeContext,
    artifacts: artifactService,
    parentTools,
  });
}
