import { createHash } from "node:crypto";
import type {
  WorkspaceFileMeta,
  WorkspaceFileRepository,
  WorkspaceFsErrorCode,
  WorkspaceScope,
} from "./contracts";
import { WorkspaceFsError, workspaceScopeKey } from "./contracts";
import type { WorkspaceFsLimits } from "./limits";
import { WORKSPACE_FS_LIMITS } from "./limits";
import { matchesGlob, mediaTypeForPath, normalizeWorkspacePath } from "./path";

export type WorkspaceFsResult<T> =
  | ({ ok: true } & T)
  | {
      ok: false;
      error: WorkspaceFsErrorCode;
      message: string;
      occurrences?: number;
    };

export type WriteResult = {
  path: string;
  created: boolean;
  size: number;
  version: number;
  sha256: string;
  mediaType: string;
};

export type ReadResult = {
  path: string;
  content: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  truncated: boolean;
  mediaType: string;
  version: number;
};

export type EditResult = {
  path: string;
  occurrences: number;
  size: number;
  version: number;
};

export type ListResult = {
  entries: Array<
    Pick<
      WorkspaceFileMeta,
      "path" | "size" | "version" | "mediaType" | "updatedAt"
    >
  >;
  total: number;
  truncated: boolean;
};

export type MoveResult = {
  fromPath: string;
  toPath: string;
  version: number;
};

export type RemoveResult = {
  path: string;
  deleted: boolean;
};

export type StatResult = {
  entry: Pick<
    WorkspaceFileMeta,
    | "path"
    | "size"
    | "version"
    | "mediaType"
    | "sha256"
    | "createdAt"
    | "updatedAt"
  >;
};

export type SearchResult = {
  files: Array<{
    path: string;
    totalMatches: number;
    lineMatches: Array<{ lineNumber: number; text: string }>;
  }>;
  truncated: boolean;
};

export type UsageResult = {
  fileCount: number;
  totalSize: number;
  limits: { maxFiles: number; maxTotalBytes: number };
};

/**
 * Result of copying a workspace file into the artifact subsystem. The
 * `downloadUrl` is the stable, same-origin link the chat UI renders; the
 * artifact route serves it with `Content-Disposition: attachment`, so a click
 * downloads the file. `artifactId` is the durable identity to re-export or
 * import later.
 */
export type ExportResult = {
  path: string;
  artifactId: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  version: number;
};

type ScopeInput = { scope: WorkspaceScope };

const MAX_LINE_TEXT = 240;

/**
 * Same-origin artifact route. It is served with `Content-Disposition:
 * attachment`, so a plain link click downloads the file — no client-side
 * download logic required.
 */
function defaultArtifactDownloadUrl(artifactId: string): string {
  return `/api/artifacts/${artifactId}`;
}

function truncateText(text: string): string {
  return text.length > MAX_LINE_TEXT
    ? `${text.slice(0, MAX_LINE_TEXT)}…`
    : text;
}

/**
 * Scoped virtual filesystem for agents. All operations validate paths,
 * enforce quotas, and are bounded by WORKSPACE_FS_LIMITS. No code execution
 * happens here — the tool API itself is the security boundary, so no
 * sandbox is required.
 */
export class WorkspaceFileService {
  constructor(
    private readonly repository: WorkspaceFileRepository,
    private readonly limits: WorkspaceFsLimits = WORKSPACE_FS_LIMITS,
  ) {}

  private keys(scope: WorkspaceScope): { userId: string; scopeKey: string } {
    return { userId: scope.userId, scopeKey: workspaceScopeKey(scope) };
  }

  private fail<T>(error: unknown): WorkspaceFsResult<T> {
    if (error instanceof WorkspaceFsError)
      return {
        ok: false,
        error: error.code,
        message: error.message,
        ...(error.details ?? {}),
      };
    return {
      ok: false,
      error: "REPOSITORY_FAILURE",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private normalize(
    path: string,
  ): { ok: true; path: string } | { ok: false; error: string } {
    return normalizeWorkspacePath(path, this.limits);
  }

  async write(
    input: ScopeInput & {
      path: string;
      content: string;
      expectedVersion?: number;
    },
  ): Promise<WorkspaceFsResult<WriteResult>> {
    try {
      const normalized = this.normalize(input.path);
      if (!normalized.ok)
        throw new WorkspaceFsError("PATH_INVALID", normalized.error);
      const path = normalized.path;
      const size = Buffer.byteLength(input.content, "utf8");
      if (size > this.limits.maxFileBytes)
        throw new WorkspaceFsError(
          "FILE_TOO_LARGE",
          `File is ${size} bytes; the limit is ${this.limits.maxFileBytes}.`,
        );
      const sha256 = createHash("sha256")
        .update(input.content, "utf8")
        .digest("hex");
      const mediaType = mediaTypeForPath(path);
      const { userId, scopeKey } = this.keys(input.scope);

      const existing = await this.repository.selectByPath(
        userId,
        scopeKey,
        path,
      );
      if (existing) {
        if (
          input.expectedVersion !== undefined &&
          input.expectedVersion !== existing.version
        )
          throw new WorkspaceFsError(
            "VERSION_CONFLICT",
            `Version conflict for ${path}: expected ${input.expectedVersion}, current ${existing.version}. Re-read the file before overwriting.`,
          );
        const updated = await this.repository.updateContent({
          userId,
          scopeKey,
          path,
          expectedVersion: existing.version,
          mediaType,
          content: input.content,
          size,
          sha256,
        });
        return {
          ok: true,
          path,
          created: false,
          size,
          version: updated.version,
          sha256,
          mediaType,
        };
      }

      const usage = await this.repository.usage(userId, scopeKey);
      if (usage.fileCount >= this.limits.maxFiles)
        throw new WorkspaceFsError(
          "QUOTA_FILE_COUNT",
          `Scope already holds ${usage.fileCount} files; the limit is ${this.limits.maxFiles}.`,
        );
      if (usage.totalSize + size > this.limits.maxTotalBytes)
        throw new WorkspaceFsError(
          "QUOTA_EXCEEDED",
          `Writing ${size} bytes would exceed the ${this.limits.maxTotalBytes}-byte scope quota (currently ${usage.totalSize}).`,
        );
      const created = await this.repository.create({
        userId,
        scopeKey,
        workspaceId: input.scope.workspaceId,
        taskId: input.scope.taskId,
        path,
        filename: path.split("/").pop() ?? path,
        mediaType,
        content: input.content,
        size,
        sha256,
      });
      return {
        ok: true,
        path,
        created: true,
        size,
        version: created.version,
        sha256,
        mediaType,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  async read(
    input: ScopeInput & {
      path: string;
      offsetLine?: number;
      limit?: number;
    },
  ): Promise<WorkspaceFsResult<ReadResult>> {
    try {
      const normalized = this.normalize(input.path);
      if (!normalized.ok)
        throw new WorkspaceFsError("PATH_INVALID", normalized.error);
      const { userId, scopeKey } = this.keys(input.scope);
      const file = await this.repository.selectByPath(
        userId,
        scopeKey,
        normalized.path,
      );
      if (!file)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `No file at ${normalized.path}. Use list or search to discover paths.`,
        );

      const lines = file.content.split("\n");
      const totalLines = lines.length;
      const offsetLine = Math.max(input.offsetLine ?? 0, 0);
      const limit = Math.min(
        input.limit ?? this.limits.maxReadLines,
        this.limits.maxReadLines,
      );
      let endLine = Math.min(offsetLine + limit, totalLines);
      let content = lines.slice(offsetLine, endLine).join("\n");
      let truncated = endLine < totalLines;
      let endLineInclusive = endLine - 1;

      while (
        Buffer.byteLength(content, "utf8") > this.limits.maxReadOutputBytes &&
        endLine > offsetLine + 1
      ) {
        endLine -= 1;
        content = lines.slice(offsetLine, endLine).join("\n");
        truncated = true;
        endLineInclusive = endLine - 1;
      }
      if (Buffer.byteLength(content, "utf8") > this.limits.maxReadOutputBytes) {
        content = content.slice(0, this.limits.maxReadOutputBytes);
        truncated = true;
      }
      return {
        ok: true,
        path: file.path,
        content,
        totalLines,
        startLine: offsetLine,
        endLine: endLineInclusive,
        truncated,
        mediaType: file.mediaType,
        version: file.version,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  async edit(
    input: ScopeInput & {
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      expectedVersion?: number;
    },
  ): Promise<WorkspaceFsResult<EditResult>> {
    try {
      const normalized = this.normalize(input.path);
      if (!normalized.ok)
        throw new WorkspaceFsError("PATH_INVALID", normalized.error);
      if (input.oldText.length === 0)
        throw new WorkspaceFsError(
          "PATH_INVALID",
          "oldText must not be empty.",
        );
      const { userId, scopeKey } = this.keys(input.scope);
      const file = await this.repository.selectByPath(
        userId,
        scopeKey,
        normalized.path,
      );
      if (!file)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `No file at ${normalized.path}.`,
        );
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== file.version
      )
        throw new WorkspaceFsError(
          "VERSION_CONFLICT",
          `Version conflict for ${file.path}: expected ${input.expectedVersion}, current ${file.version}. Re-read the file before editing.`,
        );

      const occurrences = file.content.split(input.oldText).length - 1;
      if (occurrences === 0)
        throw new WorkspaceFsError(
          "EDIT_NOT_FOUND",
          `oldText not found in ${file.path}. Copy the exact text from a fresh read.`,
        );
      if (occurrences > 1 && !input.replaceAll)
        throw new WorkspaceFsError(
          "EDIT_AMBIGUOUS",
          `oldText occurs ${occurrences} times in ${file.path}. Provide a longer unique snippet or set replaceAll.`,
          { occurrences },
        );

      const updatedContent =
        occurrences === 1
          ? file.content.replace(input.oldText, input.newText)
          : file.content.split(input.oldText).join(input.newText);
      const size = Buffer.byteLength(updatedContent, "utf8");
      if (size > this.limits.maxFileBytes)
        throw new WorkspaceFsError(
          "FILE_TOO_LARGE",
          `Edited file would be ${size} bytes; the limit is ${this.limits.maxFileBytes}.`,
        );
      const sha256 = createHash("sha256")
        .update(updatedContent, "utf8")
        .digest("hex");
      const updated = await this.repository.updateContent({
        userId,
        scopeKey,
        path: file.path,
        expectedVersion: file.version,
        mediaType: file.mediaType,
        content: updatedContent,
        size,
        sha256,
      });
      return {
        ok: true,
        path: file.path,
        occurrences: input.replaceAll ? occurrences : 1,
        size,
        version: updated.version,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  async list(
    input: ScopeInput & { path?: string },
  ): Promise<WorkspaceFsResult<ListResult>> {
    try {
      let prefix: string | undefined;
      if (input.path !== undefined && input.path.length > 0) {
        const normalized = this.normalize(input.path);
        if (!normalized.ok)
          throw new WorkspaceFsError("PATH_INVALID", normalized.error);
        prefix = `${normalized.path}/`;
      }
      const { userId, scopeKey } = this.keys(input.scope);
      const all = await this.repository.listMetadata(userId, scopeKey, prefix);
      const entries = all
        .slice(0, this.limits.maxListEntries)
        .map(({ path, size, version, mediaType, updatedAt }) => ({
          path,
          size,
          version,
          mediaType,
          updatedAt,
        }));
      return {
        ok: true,
        entries,
        total: all.length,
        truncated: all.length > entries.length,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  async move(
    input: ScopeInput & {
      fromPath: string;
      toPath: string;
      expectedVersion?: number;
    },
  ): Promise<WorkspaceFsResult<MoveResult>> {
    try {
      const from = this.normalize(input.fromPath);
      const to = this.normalize(input.toPath);
      if (!from.ok) throw new WorkspaceFsError("PATH_INVALID", from.error);
      if (!to.ok) throw new WorkspaceFsError("PATH_INVALID", to.error);
      const { userId, scopeKey } = this.keys(input.scope);
      const existing = await this.repository.selectByPath(
        userId,
        scopeKey,
        from.path,
      );
      if (!existing)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `No file at ${from.path}.`,
        );
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== existing.version
      )
        throw new WorkspaceFsError(
          "VERSION_CONFLICT",
          `Version conflict for ${from.path}: expected ${input.expectedVersion}, current ${existing.version}.`,
        );
      const moved = await this.repository.move({
        userId,
        scopeKey,
        fromPath: from.path,
        toPath: to.path,
        expectedVersion: existing.version,
      });
      return {
        ok: true,
        fromPath: from.path,
        toPath: to.path,
        version: moved.version,
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  async remove(
    input: ScopeInput & {
      path: string;
    },
  ): Promise<WorkspaceFsResult<RemoveResult>> {
    try {
      const normalized = this.normalize(input.path);
      if (!normalized.ok)
        throw new WorkspaceFsError("PATH_INVALID", normalized.error);
      const { userId, scopeKey } = this.keys(input.scope);
      const deleted = await this.repository.deletePath(
        userId,
        scopeKey,
        normalized.path,
      );
      return { ok: true, path: normalized.path, deleted };
    } catch (error) {
      return this.fail(error);
    }
  }

  async stat(
    input: ScopeInput & { path: string },
  ): Promise<WorkspaceFsResult<StatResult>> {
    try {
      const normalized = this.normalize(input.path);
      if (!normalized.ok)
        throw new WorkspaceFsError("PATH_INVALID", normalized.error);
      const { userId, scopeKey } = this.keys(input.scope);
      const file = await this.repository.selectByPath(
        userId,
        scopeKey,
        normalized.path,
      );
      if (!file)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `No file at ${normalized.path}.`,
        );
      const { content: _content, ...rest } = file;
      const { path, size, version, mediaType, sha256, createdAt, updatedAt } =
        rest;
      return {
        ok: true,
        entry: { path, size, version, mediaType, sha256, createdAt, updatedAt },
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  /**
   * Copies a workspace file into the artifact subsystem so it can be
   * downloaded. The workspace file is the working copy; the artifact is the
   * durable, user-downloadable snapshot. `createArtifact` is injected rather
   * than imported so the service stays free of storage/subsystem coupling and
   * remains testable with a fake.
   */
  async exportFile(
    input: ScopeInput & {
      path: string;
      createArtifact: (input: {
        content: string;
        filename: string;
        mediaType: string;
        userId: string;
      }) => Promise<{
        artifactId: string;
        filename: string;
        mediaType: string;
        size: number;
        sha256: string;
      }>;
      downloadUrl?: (artifactId: string) => string;
    },
  ): Promise<WorkspaceFsResult<ExportResult>> {
    try {
      const normalized = this.normalize(input.path);
      if (!normalized.ok)
        throw new WorkspaceFsError("PATH_INVALID", normalized.error);
      const { userId, scopeKey } = this.keys(input.scope);
      const file = await this.repository.selectByPath(
        userId,
        scopeKey,
        normalized.path,
      );
      if (!file)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `No file at ${normalized.path}.`,
        );

      let artifact: {
        artifactId: string;
        filename: string;
        mediaType: string;
        size: number;
        sha256: string;
      };
      try {
        artifact = await input.createArtifact({
          content: file.content,
          filename: file.filename,
          mediaType: file.mediaType,
          userId,
        });
      } catch (error) {
        throw new WorkspaceFsError(
          "EXPORT_FAILED",
          `Unable to export ${normalized.path} to storage: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      return {
        ok: true,
        path: file.path,
        artifactId: artifact.artifactId,
        filename: file.filename,
        mediaType: file.mediaType,
        size: file.size,
        sha256: file.sha256,
        version: file.version,
        downloadUrl: (input.downloadUrl ?? defaultArtifactDownloadUrl)(
          artifact.artifactId,
        ),
      };
    } catch (error) {
      return this.fail(error);
    }
  }

  async search(
    input: ScopeInput & {
      glob?: string;
      grep?: string;
      path?: string;
      caseSensitive?: boolean;
    },
  ): Promise<WorkspaceFsResult<SearchResult>> {
    try {
      const glob = input.glob?.trim();
      const grep = input.grep?.trim();
      if (!glob && !grep)
        throw new WorkspaceFsError(
          "SEARCH_EMPTY",
          "Provide a glob pattern, a grep query, or both.",
        );
      let prefix: string | undefined;
      if (input.path !== undefined && input.path.length > 0) {
        const normalized = this.normalize(input.path);
        if (!normalized.ok)
          throw new WorkspaceFsError("PATH_INVALID", normalized.error);
        prefix = `${normalized.path}/`;
      }
      const { userId, scopeKey } = this.keys(input.scope);
      const files = await this.repository.searchContent(
        userId,
        scopeKey,
        grep ?? "",
        this.limits.maxSearchMatches * 4,
      );
      const out: SearchResult["files"] = [];
      let truncated = false;
      for (const file of files) {
        if (out.length >= this.limits.maxSearchMatches) {
          truncated = true;
          break;
        }
        if (glob && !matchesGlob(glob, file.path)) continue;
        if (prefix && !file.path.startsWith(prefix)) continue;
        const needle = input.caseSensitive
          ? (grep ?? "")
          : (grep ?? "").toLowerCase();
        const lineMatches: SearchResult["files"][number]["lineMatches"] = [];
        let totalMatches = 0;
        const lines = file.content.split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          const line = input.caseSensitive
            ? lines[i]!
            : lines[i]!.toLowerCase();
          if (grep && !line.includes(needle)) continue;
          totalMatches += 1;
          if (lineMatches.length < this.limits.maxSearchLinesPerFile)
            lineMatches.push({
              lineNumber: i + 1,
              text: truncateText(lines[i]!),
            });
        }
        if (grep && totalMatches === 0) continue;
        if (totalMatches > lineMatches.length) truncated = true;
        out.push({ path: file.path, totalMatches, lineMatches });
      }
      return { ok: true, files: out, truncated };
    } catch (error) {
      return this.fail(error);
    }
  }

  async usage(input: ScopeInput): Promise<WorkspaceFsResult<UsageResult>> {
    try {
      const { userId, scopeKey } = this.keys(input.scope);
      const usage = await this.repository.usage(userId, scopeKey);
      return {
        ok: true,
        fileCount: usage.fileCount,
        totalSize: usage.totalSize,
        limits: {
          maxFiles: this.limits.maxFiles,
          maxTotalBytes: this.limits.maxTotalBytes,
        },
      };
    } catch (error) {
      return this.fail(error);
    }
  }
}
