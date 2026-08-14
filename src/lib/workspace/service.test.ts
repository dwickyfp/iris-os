import type {
  Workspace,
  WorkspaceCreateData,
  WorkspaceUpdateInput,
} from "app-types/workspace";
import { describe, expect, it } from "vitest";
import { createWorkspaceService, type WorkspaceRepository } from "./service";

function createMemoryRepository(seed: Workspace[] = []): WorkspaceRepository {
  const rows = new Map(seed.map((workspace) => [workspace.id, workspace]));

  return {
    async listByUserId(userId, status) {
      return [...rows.values()].filter(
        (workspace) =>
          workspace.userId === userId &&
          (status === undefined || workspace.status === status),
      );
    },
    async selectById(id, userId) {
      const workspace = rows.get(id);
      return workspace?.userId === userId ? workspace : null;
    },
    async insert(userId: string, input: WorkspaceCreateData) {
      const now = new Date("2026-08-14T00:00:00Z");
      const workspace: Workspace = {
        ...input,
        id: `workspace-${rows.size + 1}`,
        userId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      rows.set(workspace.id, workspace);
      return workspace;
    },
    async update(id: string, userId: string, input: WorkspaceUpdateInput) {
      const workspace = rows.get(id);
      if (!workspace || workspace.userId !== userId) return null;
      const updated = { ...workspace, ...input, updatedAt: new Date() };
      rows.set(id, updated);
      return updated;
    },
  };
}

const activeWorkspace: Workspace = {
  id: "workspace-1",
  userId: "user-1",
  name: "IRIS",
  slug: "iris",
  status: "active",
  defaultToolMode: "auto",
  createdAt: new Date("2026-08-14T00:00:00Z"),
  updatedAt: new Date("2026-08-14T00:00:00Z"),
};

describe("WorkspaceService", () => {
  it("validates and creates a workspace for the current user", async () => {
    const service = createWorkspaceService(createMemoryRepository());

    await expect(
      service.create("user-1", {
        name: "  IRIS-OS  ",
        slug: "iris-os",
      }),
    ).resolves.toMatchObject({
      userId: "user-1",
      name: "IRIS-OS",
      slug: "iris-os",
      status: "active",
      defaultToolMode: "auto",
    });
  });

  it("lists only workspaces owned by the current user", async () => {
    const service = createWorkspaceService(
      createMemoryRepository([
        activeWorkspace,
        { ...activeWorkspace, id: "workspace-2", userId: "user-2" },
      ]),
    );

    await expect(service.list("user-1")).resolves.toEqual([activeWorkspace]);
  });

  it("archives through an owner-scoped update", async () => {
    const service = createWorkspaceService(
      createMemoryRepository([activeWorkspace]),
    );

    await expect(
      service.archive("user-1", "workspace-1"),
    ).resolves.toMatchObject({ id: "workspace-1", status: "archived" });
  });

  it("hides an update target that is not owned", async () => {
    const service = createWorkspaceService(
      createMemoryRepository([activeWorkspace]),
    );

    await expect(
      service.update("user-2", "workspace-1", { name: "Stolen" }),
    ).rejects.toThrow("Workspace not found");
  });

  it("resolves an active workspace owned by the user", async () => {
    const service = createWorkspaceService(
      createMemoryRepository([activeWorkspace]),
    );

    await expect(
      service.resolveRequestedWorkspace("user-1", "workspace-1"),
    ).resolves.toEqual(activeWorkspace);
  });

  it("does not expose another user's workspace", async () => {
    const service = createWorkspaceService(
      createMemoryRepository([activeWorkspace]),
    );

    await expect(
      service.resolveRequestedWorkspace("user-2", "workspace-1"),
    ).rejects.toThrow("Workspace not found");
  });

  it("does not resolve an archived workspace for new work", async () => {
    const service = createWorkspaceService(
      createMemoryRepository([{ ...activeWorkspace, status: "archived" }]),
    );

    await expect(
      service.resolveRequestedWorkspace("user-1", "workspace-1"),
    ).rejects.toThrow("Workspace not found");
  });

  it("returns global mode when no workspace is requested", async () => {
    const service = createWorkspaceService(createMemoryRepository());
    await expect(
      service.resolveRequestedWorkspace("user-1", undefined),
    ).resolves.toBeUndefined();
  });
});
