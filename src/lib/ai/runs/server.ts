import "server-only";

import { agentRunRepository } from "lib/db/repository";
import { RunManager } from "./run-manager";

export const runManager = new RunManager(agentRunRepository);
