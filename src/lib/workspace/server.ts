import "server-only";

import { workspaceRepository } from "lib/db/repository";
import { createWorkspaceService } from "./service";

export const workspaceService = createWorkspaceService(workspaceRepository);
