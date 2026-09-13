import type {
  WorkspaceFileMeta,
  WorkspaceFileRecord,
  WorkspaceFileRepository,
  WorkspaceFsRepositoryCreateInput,
  WorkspaceFsRepositoryMoveInput,
  WorkspaceFsRepositoryUpdateInput,
} from "./contracts";
import { WorkspaceFsError } from "./contracts";

type Stored = WorkspaceFileRecord;

function sortMeta(a: WorkspaceFileMeta, b: WorkspaceFileMeta) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Faithful in-memory implementation of WorkspaceFileRepository for unit
 * tests and benchmarks. Mirrors the Postgres semantics: unique
 * (user, scope, path), optimistic version checks, ordered metadata lists.
 */
export function createInMemoryWorkspaceFileRepository(): WorkspaceFileRepository & {
  seed(
    files: Array<
      Pick<WorkspaceFileRecord, "userId" | "scopeKey" | "path" | "content">
    >,
  ): void;
} {
  const files = new Map<string, Stored>();
  const key = (userId: string, scopeKey: string, path: string) =>
    `${userId}\u0000${scopeKey}\u0000${path}`;

  const repo: WorkspaceFileRepository & {
    seed(
      files: Array<
        Pick<WorkspaceFileRecord, "userId" | "scopeKey" | "path" | "content">
      >,
    ): void;
  } = {
    seed(inputs) {
      files.clear();
      let i = 0;
      for (const input of inputs) {
        i += 1;
        const now = new Date(2026, 0, 1, 0, 0, i);
        files.set(key(input.userId, input.scopeKey, input.path), {
          id: `seed-${i}`,
          userId: input.userId,
          scopeKey: input.scopeKey,
          path: input.path,
          filename: input.path.split("/").pop() ?? input.path,
          mediaType: "text/plain",
          content: input.content,
          size: Buffer.byteLength(input.content, "utf8"),
          sha256: `sha-${i}`,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    },

    async create(input: WorkspaceFsRepositoryCreateInput) {
      const k = key(input.userId, input.scopeKey, input.path);
      if (files.has(k))
        throw new WorkspaceFsError(
          "PATH_EXISTS",
          `Path already exists: ${input.path}`,
        );
      const now = new Date();
      const created: Stored = {
        id: `wf-${files.size + 1}`,
        userId: input.userId,
        scopeKey: input.scopeKey,
        path: input.path,
        filename: input.filename,
        mediaType: input.mediaType,
        content: input.content,
        size: input.size,
        sha256: input.sha256,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      files.set(k, created);
      return { ...created };
    },

    async selectByPath(userId, scopeKey, path) {
      const found = files.get(key(userId, scopeKey, path));
      return found ? { ...found } : null;
    },

    async listMetadata(userId, scopeKey, prefix) {
      const out: WorkspaceFileMeta[] = [];
      for (const file of files.values()) {
        if (file.userId !== userId || file.scopeKey !== scopeKey) continue;
        if (prefix && !file.path.startsWith(prefix)) continue;
        const { content: _content, ...meta } = file;
        out.push({ ...meta });
      }
      return out.sort(sortMeta);
    },

    async updateContent(input: WorkspaceFsRepositoryUpdateInput) {
      const k = key(input.userId, input.scopeKey, input.path);
      const existing = files.get(k);
      if (!existing)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `Path not found: ${input.path}`,
        );
      if (existing.version !== input.expectedVersion)
        throw new WorkspaceFsError(
          "VERSION_CONFLICT",
          `Version conflict for ${input.path}: expected ${input.expectedVersion}, current ${existing.version}`,
        );
      const updated: Stored = {
        ...existing,
        content: input.content,
        size: input.size,
        sha256: input.sha256,
        mediaType: input.mediaType,
        version: existing.version + 1,
        updatedAt: new Date(),
      };
      files.set(k, updated);
      return { ...updated };
    },

    async move(input: WorkspaceFsRepositoryMoveInput) {
      const fromKey = key(input.userId, input.scopeKey, input.fromPath);
      const existing = files.get(fromKey);
      if (!existing)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `Path not found: ${input.fromPath}`,
        );
      if (existing.version !== input.expectedVersion)
        throw new WorkspaceFsError(
          "VERSION_CONFLICT",
          `Version conflict for ${input.fromPath}`,
        );
      const toKey = key(input.userId, input.scopeKey, input.toPath);
      if (files.has(toKey))
        throw new WorkspaceFsError(
          "PATH_EXISTS",
          `Path already exists: ${input.toPath}`,
        );
      const moved: Stored = {
        ...existing,
        path: input.toPath,
        filename: input.toPath.split("/").pop() ?? input.toPath,
        version: existing.version + 1,
        updatedAt: new Date(),
      };
      files.delete(fromKey);
      files.set(toKey, moved);
      return { ...moved };
    },

    async deletePath(userId, scopeKey, path) {
      const k = key(userId, scopeKey, path);
      return files.delete(k);
    },

    async searchContent(userId, scopeKey, needle, limit) {
      const lower = needle.toLowerCase();
      const out: WorkspaceFileRecord[] = [];
      for (const file of files.values()) {
        if (file.userId !== userId || file.scopeKey !== scopeKey) continue;
        if (!file.content.toLowerCase().includes(lower)) continue;
        out.push({ ...file });
        if (out.length >= limit) break;
      }
      return out;
    },

    async usage(userId, scopeKey) {
      let fileCount = 0;
      let totalSize = 0;
      for (const file of files.values()) {
        if (file.userId !== userId || file.scopeKey !== scopeKey) continue;
        fileCount += 1;
        totalSize += file.size;
      }
      return { fileCount, totalSize };
    },
  };
  return repo;
}
