export type WorkspaceScope = {
  userId: string;
  workspaceId?: string;
  taskId?: string;
};

/**
 * Scope precedence mirrors AgentRuntimeContext: a task lives inside its
 * workspace, so an explicit task scope is the narrowest. The scope key is the
 * filesystem root identity; ownership is enforced by (userId, scopeKey) in
 * every repository query — client-supplied scope is never authoritative.
 */
export function workspaceScopeKey(scope: WorkspaceScope): string {
  if (scope.taskId) return `task:${scope.taskId}`;
  if (scope.workspaceId) return `workspace:${scope.workspaceId}`;
  return "global";
}

export interface WorkspaceFileMeta {
  id: string;
  userId: string;
  scopeKey: string;
  workspaceId?: string;
  taskId?: string;
  path: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceFileRecord extends WorkspaceFileMeta {
  content: string;
}

export type WorkspaceFsErrorCode =
  | "PATH_INVALID"
  | "PATH_EXISTS"
  | "PATH_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "FILE_TOO_LARGE"
  | "QUOTA_EXCEEDED"
  | "QUOTA_FILE_COUNT"
  | "EDIT_NOT_FOUND"
  | "EDIT_AMBIGUOUS"
  | "SEARCH_EMPTY"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_UNSUPPORTED"
  | "ARTIFACT_TOO_LARGE"
  | "EXPORT_FAILED"
  | "REPOSITORY_FAILURE";

export class WorkspaceFsError extends Error {
  readonly code: WorkspaceFsErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: WorkspaceFsErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkspaceFsError";
    this.code = code;
    this.details = details;
  }
}

export type WorkspaceFsRepositoryCreateInput = {
  userId: string;
  scopeKey: string;
  workspaceId?: string;
  taskId?: string;
  path: string;
  filename: string;
  mediaType: string;
  content: string;
  size: number;
  sha256: string;
};

export type WorkspaceFsRepositoryUpdateInput = {
  userId: string;
  scopeKey: string;
  path: string;
  expectedVersion: number;
  mediaType: string;
  content: string;
  size: number;
  sha256: string;
};

export type WorkspaceFsRepositoryMoveInput = {
  userId: string;
  scopeKey: string;
  fromPath: string;
  toPath: string;
  expectedVersion: number;
};

/**
 * Repository contract for workspace files. Implementations must enforce
 * uniqueness of (userId, scopeKey, path), optimistic version checks, and
 * scope-scoped queries only. Expected failures are thrown as
 * WorkspaceFsError with codes PATH_EXISTS, PATH_NOT_FOUND, VERSION_CONFLICT.
 */
export interface WorkspaceFileRepository {
  create(input: WorkspaceFsRepositoryCreateInput): Promise<WorkspaceFileRecord>;
  selectByPath(
    userId: string,
    scopeKey: string,
    path: string,
  ): Promise<WorkspaceFileRecord | null>;
  listMetadata(
    userId: string,
    scopeKey: string,
    prefix?: string,
  ): Promise<WorkspaceFileMeta[]>;
  updateContent(
    input: WorkspaceFsRepositoryUpdateInput,
  ): Promise<WorkspaceFileRecord>;
  move(input: WorkspaceFsRepositoryMoveInput): Promise<WorkspaceFileRecord>;
  deletePath(userId: string, scopeKey: string, path: string): Promise<boolean>;
  searchContent(
    userId: string,
    scopeKey: string,
    needle: string,
    limit: number,
  ): Promise<WorkspaceFileRecord[]>;
  usage(
    userId: string,
    scopeKey: string,
  ): Promise<{ fileCount: number; totalSize: number }>;
}
