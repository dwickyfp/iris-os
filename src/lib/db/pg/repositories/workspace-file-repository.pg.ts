import "server-only";

import { and, eq, sql } from "drizzle-orm";
import type {
  WorkspaceFileMeta,
  WorkspaceFileRecord,
  WorkspaceFileRepository,
  WorkspaceFsRepositoryCreateInput,
  WorkspaceFsRepositoryMoveInput,
  WorkspaceFsRepositoryUpdateInput,
} from "lib/ai/workspace-fs/contracts";
import { WorkspaceFsError } from "lib/ai/workspace-fs/contracts";
import { pgDb as db } from "../db.pg";
import { WorkspaceFileTable } from "../schema.pg";

const metaColumns = {
  id: WorkspaceFileTable.id,
  userId: WorkspaceFileTable.userId,
  scopeKey: WorkspaceFileTable.scopeKey,
  workspaceId: WorkspaceFileTable.workspaceId,
  taskId: WorkspaceFileTable.taskId,
  path: WorkspaceFileTable.path,
  filename: WorkspaceFileTable.filename,
  mediaType: WorkspaceFileTable.mediaType,
  size: WorkspaceFileTable.size,
  sha256: WorkspaceFileTable.sha256,
  version: WorkspaceFileTable.version,
  createdAt: WorkspaceFileTable.createdAt,
  updatedAt: WorkspaceFileTable.updatedAt,
};

type Row = typeof WorkspaceFileTable.$inferSelect;

function toRecord(row: Row): WorkspaceFileRecord {
  return {
    id: row.id,
    userId: row.userId,
    scopeKey: row.scopeKey,
    workspaceId: row.workspaceId ?? undefined,
    taskId: row.taskId ?? undefined,
    path: row.path,
    filename: row.filename,
    mediaType: row.mediaType,
    content: row.content,
    size: row.size,
    sha256: row.sha256,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMeta(row: Omit<Row, "content">): WorkspaceFileMeta {
  return {
    id: row.id,
    userId: row.userId,
    scopeKey: row.scopeKey,
    workspaceId: row.workspaceId ?? undefined,
    taskId: row.taskId ?? undefined,
    path: row.path,
    filename: row.filename,
    mediaType: row.mediaType,
    size: row.size,
    sha256: row.sha256,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function escapeLike(needle: string): string {
  return needle.replace(/[\\%_]/g, "\\$&");
}

function isUniqueViolation(error: unknown): boolean {
  // SAFETY: node-postgres raises driver errors carrying a SQLSTATE `code`;
  // the field's presence is verified with `in` before comparison.
  return error instanceof Error && "code" in error && error.code === "23505";
}

async function scopeExists(
  userId: string,
  scopeKey: string,
  path: string,
): Promise<Row | null> {
  const [row] = await db
    .select()
    .from(WorkspaceFileTable)
    .where(
      and(
        eq(WorkspaceFileTable.userId, userId),
        eq(WorkspaceFileTable.scopeKey, scopeKey),
        eq(WorkspaceFileTable.path, path),
      ),
    )
    .limit(1);
  return row ?? null;
}

export const pgWorkspaceFileRepository: WorkspaceFileRepository = {
  async create(input: WorkspaceFsRepositoryCreateInput) {
    try {
      const [created] = await db
        .insert(WorkspaceFileTable)
        .values({
          userId: input.userId,
          scopeKey: input.scopeKey,
          workspaceId: input.workspaceId ?? null,
          taskId: input.taskId ?? null,
          path: input.path,
          filename: input.filename,
          mediaType: input.mediaType,
          content: input.content,
          size: input.size,
          sha256: input.sha256,
        })
        .returning();
      return toRecord(created!);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new WorkspaceFsError(
          "PATH_EXISTS",
          `Path already exists: ${input.path}`,
        );
      throw error;
    }
  },

  async selectByPath(userId, scopeKey, path) {
    const row = await scopeExists(userId, scopeKey, path);
    return row ? toRecord(row) : null;
  },

  async listMetadata(userId, scopeKey, prefix) {
    const conditions = [
      eq(WorkspaceFileTable.userId, userId),
      eq(WorkspaceFileTable.scopeKey, scopeKey),
    ];
    if (prefix)
      conditions.push(
        sql`${WorkspaceFileTable.path} LIKE ${`${escapeLike(prefix)}%`} ESCAPE '\\'`,
      );
    const rows = await db
      .select(metaColumns)
      .from(WorkspaceFileTable)
      .where(and(...conditions))
      .orderBy(WorkspaceFileTable.path);
    return rows.map(toMeta);
  },

  async updateContent(input: WorkspaceFsRepositoryUpdateInput) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(WorkspaceFileTable)
        .where(
          and(
            eq(WorkspaceFileTable.userId, input.userId),
            eq(WorkspaceFileTable.scopeKey, input.scopeKey),
            eq(WorkspaceFileTable.path, input.path),
          ),
        )
        .for("update")
        .limit(1);
      if (!row)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `Path not found: ${input.path}`,
        );
      if (row.version !== input.expectedVersion)
        throw new WorkspaceFsError(
          "VERSION_CONFLICT",
          `Version conflict for ${input.path}: expected ${input.expectedVersion}, current ${row.version}`,
        );
      const [updated] = await tx
        .update(WorkspaceFileTable)
        .set({
          mediaType: input.mediaType,
          content: input.content,
          size: input.size,
          sha256: input.sha256,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(WorkspaceFileTable.id, row.id))
        .returning();
      return toRecord(updated!);
    });
  },

  async move(input: WorkspaceFsRepositoryMoveInput) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(WorkspaceFileTable)
        .where(
          and(
            eq(WorkspaceFileTable.userId, input.userId),
            eq(WorkspaceFileTable.scopeKey, input.scopeKey),
            eq(WorkspaceFileTable.path, input.fromPath),
          ),
        )
        .for("update")
        .limit(1);
      if (!row)
        throw new WorkspaceFsError(
          "PATH_NOT_FOUND",
          `Path not found: ${input.fromPath}`,
        );
      if (row.version !== input.expectedVersion)
        throw new WorkspaceFsError(
          "VERSION_CONFLICT",
          `Version conflict for ${input.fromPath}: expected ${input.expectedVersion}, current ${row.version}`,
        );
      const [target] = await tx
        .select({ id: WorkspaceFileTable.id })
        .from(WorkspaceFileTable)
        .where(
          and(
            eq(WorkspaceFileTable.userId, input.userId),
            eq(WorkspaceFileTable.scopeKey, input.scopeKey),
            eq(WorkspaceFileTable.path, input.toPath),
          ),
        )
        .limit(1);
      if (target)
        throw new WorkspaceFsError(
          "PATH_EXISTS",
          `Path already exists: ${input.toPath}`,
        );
      const [moved] = await tx
        .update(WorkspaceFileTable)
        .set({
          path: input.toPath,
          filename: input.toPath.split("/").pop() ?? input.toPath,
          version: row.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(WorkspaceFileTable.id, row.id))
        .returning();
      return toRecord(moved!);
    });
  },

  async deletePath(userId, scopeKey, path) {
    const deleted = await db
      .delete(WorkspaceFileTable)
      .where(
        and(
          eq(WorkspaceFileTable.userId, userId),
          eq(WorkspaceFileTable.scopeKey, scopeKey),
          eq(WorkspaceFileTable.path, path),
        ),
      )
      .returning({ id: WorkspaceFileTable.id });
    return deleted.length > 0;
  },

  async searchContent(userId, scopeKey, needle, limit) {
    const rows = await db
      .select()
      .from(WorkspaceFileTable)
      .where(
        and(
          eq(WorkspaceFileTable.userId, userId),
          eq(WorkspaceFileTable.scopeKey, scopeKey),
          sql`${WorkspaceFileTable.content} ILIKE ${`%${escapeLike(needle)}%`} ESCAPE '\\'`,
        ),
      )
      .orderBy(WorkspaceFileTable.path)
      .limit(limit);
    return rows.map(toRecord);
  },

  async usage(userId, scopeKey) {
    const [row] = await db
      .select({
        fileCount: sql<number>`count(*)::int`,
        totalSize: sql<number>`coalesce(sum(${WorkspaceFileTable.size}), 0)::int`,
      })
      .from(WorkspaceFileTable)
      .where(
        and(
          eq(WorkspaceFileTable.userId, userId),
          eq(WorkspaceFileTable.scopeKey, scopeKey),
        ),
      );
    return {
      fileCount: row?.fileCount ?? 0,
      totalSize: row?.totalSize ?? 0,
    };
  },
};
