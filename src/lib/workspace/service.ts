import type {
  Workspace,
  WorkspaceCreateData,
  WorkspaceCreateInput,
  WorkspaceStatus,
  WorkspaceUpdateInput,
} from "app-types/workspace";
import {
  WorkspaceCreateSchema,
  WorkspaceUpdateSchema,
} from "app-types/workspace";

function requireWorkspace(workspace: Workspace | null) {
  if (!workspace) throw new Error("Workspace not found");
  return workspace;
}

export type WorkspaceRepository = {
  listByUserId(userId: string, status?: WorkspaceStatus): Promise<Workspace[]>;
  selectById(id: string, userId: string): Promise<Workspace | null>;
  insert(userId: string, input: WorkspaceCreateData): Promise<Workspace>;
  update(
    id: string,
    userId: string,
    input: WorkspaceUpdateInput,
  ): Promise<Workspace | null>;
};

export function createWorkspaceService(repository: WorkspaceRepository) {
  return {
    async create(userId: string, input: WorkspaceCreateInput) {
      return repository.insert(userId, WorkspaceCreateSchema.parse(input));
    },
    async list(userId: string, status?: WorkspaceStatus) {
      return repository.listByUserId(userId, status);
    },
    async update(
      userId: string,
      workspaceId: string,
      input: WorkspaceUpdateInput,
    ) {
      const workspace = await repository.update(
        workspaceId,
        userId,
        WorkspaceUpdateSchema.parse(input),
      );
      return requireWorkspace(workspace);
    },
    async archive(userId: string, workspaceId: string) {
      return requireWorkspace(
        await repository.update(workspaceId, userId, { status: "archived" }),
      );
    },
    async resolveRequestedWorkspace(
      userId: string,
      workspaceId?: string,
    ): Promise<Workspace | undefined> {
      if (!workspaceId) return undefined;
      const workspace = await repository.selectById(workspaceId, userId);
      if (!workspace || workspace.status !== "active") {
        throw new Error("Workspace not found");
      }
      return workspace;
    },
  };
}
