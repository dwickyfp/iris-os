import "server-only";

import { createA2AProvider } from "lib/a2a/provider";
import { remoteAgentRepository } from "lib/db/repository";
import { createRemoteAgentService } from "./service";

export const remoteAgentService = createRemoteAgentService(
  remoteAgentRepository,
  createA2AProvider(),
);
