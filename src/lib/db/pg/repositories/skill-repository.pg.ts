import type {
  AgentSkillAssignment,
  Skill,
  SkillRepository,
  SkillSummary,
} from "app-types/skill";
import {
  MAX_SKILL_ASSIGNMENTS,
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_FILE_SIZE,
  SkillCreateSchema,
  SkillFileSchema,
  SkillUpdateSchema,
} from "app-types/skill";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { generateUUID } from "lib/utils";
import { pgDb as db } from "../db.pg";
import {
  AgentSkillTable,
  AgentTable,
  BookmarkTable,
  SkillFileTable,
  SkillTable,
  UserTable,
} from "../schema.pg";

type SkillRow = typeof SkillTable.$inferSelect;

async function loadFiles(skillIds: string[]) {
  const filesBySkill = new Map<string, Skill["files"]>();
  if (skillIds.length === 0) return filesBySkill;

  const files = await db
    .select({
      skillId: SkillFileTable.skillId,
      path: SkillFileTable.path,
      content: SkillFileTable.content,
      mimeType: SkillFileTable.mimeType,
      size: SkillFileTable.size,
    })
    .from(SkillFileTable)
    .where(inArray(SkillFileTable.skillId, skillIds))
    .orderBy(SkillFileTable.path);

  for (const file of files) {
    const skillFiles = filesBySkill.get(file.skillId) ?? [];
    skillFiles.push({
      path: file.path,
      content: file.content,
      mimeType: file.mimeType,
      size: file.size,
    });
    filesBySkill.set(file.skillId, skillFiles);
  }
  return filesBySkill;
}

function toSkill(row: SkillRow, files: Skill["files"]): Skill {
  return {
    ...row,
    icon: row.icon ?? undefined,
    license: row.license ?? undefined,
    compatibility: row.compatibility ?? undefined,
    metadata: row.metadata ?? undefined,
    allowedTools: row.allowedTools ?? undefined,
    sourceCandidateId: row.sourceCandidateId ?? undefined,
    archivedAt: row.archivedAt ?? undefined,
    files,
  };
}

function fileValues(skillId: string, files: Skill["files"]) {
  return files.map((file) => ({
    id: generateUUID(),
    skillId,
    path: file.path,
    content: file.content,
    mimeType: file.mimeType ?? "application/octet-stream",
    size: file.size ?? new TextEncoder().encode(file.content).byteLength,
  }));
}

function normalizeFile(file: Skill["files"][number]) {
  return {
    ...file,
    mimeType: file.mimeType ?? "application/octet-stream",
    size: file.size ?? new TextEncoder().encode(file.content).byteLength,
  };
}

export const pgSkillRepository: SkillRepository = {
  async insertSkill(skill) {
    const input = SkillCreateSchema.parse(skill);
    return db.transaction(async (tx) => {
      const [result] = await tx
        .insert(SkillTable)
        .values({
          id: generateUUID(),
          name: input.name,
          description: input.description,
          icon: input.icon,
          license: input.license,
          compatibility: input.compatibility,
          metadata: input.metadata,
          provenance: "manual",
          allowedTools: input.allowedTools,
          userId: input.userId,
          body: input.body,
          visibility: input.visibility,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      if (input.files.length > 0) {
        await tx
          .insert(SkillFileTable)
          .values(fileValues(result.id, input.files));
      }
      return toSkill(result, input.files);
    });
  },

  async selectSkillById(id, userId) {
    const [result] = await db
      .select({
        id: SkillTable.id,
        name: SkillTable.name,
        description: SkillTable.description,
        icon: SkillTable.icon,
        license: SkillTable.license,
        compatibility: SkillTable.compatibility,
        metadata: SkillTable.metadata,
        provenance: SkillTable.provenance,
        sourceCandidateId: SkillTable.sourceCandidateId,
        version: SkillTable.version,
        allowedTools: SkillTable.allowedTools,
        userId: SkillTable.userId,
        body: SkillTable.body,
        visibility: SkillTable.visibility,
        archivedAt: SkillTable.archivedAt,
        createdAt: SkillTable.createdAt,
        updatedAt: SkillTable.updatedAt,
        isBookmarked: sql<boolean>`${BookmarkTable.id} IS NOT NULL`,
      })
      .from(SkillTable)
      .leftJoin(
        BookmarkTable,
        and(
          eq(BookmarkTable.itemId, SkillTable.id),
          eq(BookmarkTable.userId, userId),
          eq(BookmarkTable.itemType, "skill"),
        ),
      )
      .where(
        and(
          eq(SkillTable.id, id),
          or(
            eq(SkillTable.userId, userId),
            and(
              eq(SkillTable.visibility, "readonly"),
              isNull(SkillTable.archivedAt),
            ),
          ),
        ),
      );

    if (!result) return null;
    const files = await loadFiles([result.id]);
    return {
      ...result,
      icon: result.icon ?? undefined,
      license: result.license ?? undefined,
      compatibility: result.compatibility ?? undefined,
      metadata: result.metadata ?? undefined,
      allowedTools: result.allowedTools ?? undefined,
      sourceCandidateId: result.sourceCandidateId ?? undefined,
      archivedAt: result.archivedAt ?? undefined,
      files: files.get(result.id) ?? [],
      isBookmarked: result.isBookmarked ?? false,
    };
  },

  async selectSkillsByUserId(userId) {
    const results = await db
      .select()
      .from(SkillTable)
      .where(eq(SkillTable.userId, userId))
      .orderBy(desc(SkillTable.createdAt));
    const files = await loadFiles(results.map(({ id }) => id));
    return results.map((result) => toSkill(result, files.get(result.id) ?? []));
  },

  async updateSkill(id, userId, skill) {
    const input = SkillUpdateSchema.parse(skill);
    return db.transaction(async (tx) => {
      const { files, ...values } = input;
      const [result] = await tx
        .update(SkillTable)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId)))
        .returning();
      if (!result) throw new Error("Skill not found");

      if (files) {
        await tx.delete(SkillFileTable).where(eq(SkillFileTable.skillId, id));
        if (files.length > 0) {
          await tx.insert(SkillFileTable).values(fileValues(id, files));
        }
      }

      const currentFiles = files
        ? files.map(normalizeFile)
        : await tx
            .select({
              path: SkillFileTable.path,
              content: SkillFileTable.content,
              mimeType: SkillFileTable.mimeType,
              size: SkillFileTable.size,
            })
            .from(SkillFileTable)
            .where(eq(SkillFileTable.skillId, id))
            .orderBy(SkillFileTable.path);
      return toSkill(result, currentFiles);
    });
  },

  async deleteSkill(id, userId) {
    await db
      .delete(SkillTable)
      .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId)));
  },

  async archiveSkill(id, userId) {
    return db.transaction(async (tx) => {
      const [assignment] = await tx
        .select({ id: AgentSkillTable.id })
        .from(AgentSkillTable)
        .innerJoin(SkillTable, eq(AgentSkillTable.skillId, SkillTable.id))
        .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId)))
        .limit(1);
      if (assignment) throw new Error("Assigned skills cannot be archived");

      const [result] = await tx
        .update(SkillTable)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId)))
        .returning();
      if (!result) throw new Error("Skill not found");
      const files = await tx
        .select({
          path: SkillFileTable.path,
          content: SkillFileTable.content,
          mimeType: SkillFileTable.mimeType,
          size: SkillFileTable.size,
        })
        .from(SkillFileTable)
        .where(eq(SkillFileTable.skillId, id))
        .orderBy(SkillFileTable.path);
      return toSkill(result, files);
    });
  },

  async restoreSkill(id, userId) {
    return db.transaction(async (tx) => {
      const [assignment] = await tx
        .select({ id: AgentSkillTable.id })
        .from(AgentSkillTable)
        .innerJoin(SkillTable, eq(AgentSkillTable.skillId, SkillTable.id))
        .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId)))
        .limit(1);
      if (assignment) throw new Error("Assigned skills cannot be restored");

      const [result] = await tx
        .update(SkillTable)
        .set({ archivedAt: null, updatedAt: new Date() })
        .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId)))
        .returning();
      if (!result) throw new Error("Skill not found");
      const files = await tx
        .select({
          path: SkillFileTable.path,
          content: SkillFileTable.content,
          mimeType: SkillFileTable.mimeType,
          size: SkillFileTable.size,
        })
        .from(SkillFileTable)
        .where(eq(SkillFileTable.skillId, id))
        .orderBy(SkillFileTable.path);
      return toSkill(result, files);
    });
  },

  async selectSkills(
    currentUserId,
    filters = ["all"],
    limit = 50,
    archived = false,
  ) {
    let conditions = filters.map((filter) => {
      if (filter === "mine") return eq(SkillTable.userId, currentUserId);
      if (filter === "shared") {
        return and(
          ne(SkillTable.userId, currentUserId),
          eq(SkillTable.visibility, "readonly"),
        );
      }
      if (filter === "bookmarked") {
        return and(
          ne(SkillTable.userId, currentUserId),
          eq(SkillTable.visibility, "readonly"),
          sql`${BookmarkTable.id} IS NOT NULL`,
        );
      }
      return or(
        eq(SkillTable.userId, currentUserId),
        eq(SkillTable.visibility, "readonly"),
      );
    });
    if (filters.includes("all")) {
      conditions = [
        or(
          eq(SkillTable.userId, currentUserId),
          eq(SkillTable.visibility, "readonly"),
        ),
      ];
    }

    const results = await db
      .select({
        id: SkillTable.id,
        name: SkillTable.name,
        description: SkillTable.description,
        icon: SkillTable.icon,
        license: SkillTable.license,
        compatibility: SkillTable.compatibility,
        metadata: SkillTable.metadata,
        provenance: SkillTable.provenance,
        allowedTools: SkillTable.allowedTools,
        userId: SkillTable.userId,
        visibility: SkillTable.visibility,
        archivedAt: SkillTable.archivedAt,
        createdAt: SkillTable.createdAt,
        updatedAt: SkillTable.updatedAt,
        userName: UserTable.name,
        userAvatar: UserTable.image,
        isBookmarked: sql<boolean>`${BookmarkTable.id} IS NOT NULL`,
      })
      .from(SkillTable)
      .innerJoin(UserTable, eq(SkillTable.userId, UserTable.id))
      .leftJoin(
        BookmarkTable,
        and(
          eq(BookmarkTable.itemId, SkillTable.id),
          eq(BookmarkTable.userId, currentUserId),
          eq(BookmarkTable.itemType, "skill"),
        ),
      )
      .where(
        and(
          archived
            ? sql`${SkillTable.archivedAt} IS NOT NULL`
            : isNull(SkillTable.archivedAt),
          conditions.length > 1 ? or(...conditions) : conditions[0],
        ),
      )
      .orderBy(
        sql`CASE WHEN ${SkillTable.userId} = ${currentUserId} THEN 0 ELSE 1 END`,
        desc(SkillTable.createdAt),
      )
      .limit(limit);

    return results.map(
      (result): SkillSummary => ({
        ...result,
        icon: result.icon ?? undefined,
        license: result.license ?? undefined,
        compatibility: result.compatibility ?? undefined,
        metadata: result.metadata ?? undefined,
        allowedTools: result.allowedTools ?? undefined,
        archivedAt: result.archivedAt ?? undefined,
        userAvatar: result.userAvatar ?? undefined,
      }),
    );
  },

  async replaceAgentSkills(agentId, userId, skillIds) {
    if (skillIds.length > MAX_SKILL_ASSIGNMENTS) {
      throw new Error(
        `Agents can have at most ${MAX_SKILL_ASSIGNMENTS} skills`,
      );
    }
    if (new Set(skillIds).size !== skillIds.length) {
      throw new Error("Agent skill assignments must be unique");
    }

    await db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ id: AgentTable.id, visibility: AgentTable.visibility })
        .from(AgentTable)
        .where(and(eq(AgentTable.id, agentId), eq(AgentTable.userId, userId)));
      if (!agent) throw new Error("Agent not found");

      if (skillIds.length > 0) {
        const available = await tx
          .select({
            id: SkillTable.id,
            userId: SkillTable.userId,
            visibility: SkillTable.visibility,
          })
          .from(SkillTable)
          .where(
            and(
              inArray(SkillTable.id, skillIds),
              isNull(SkillTable.archivedAt),
              or(
                eq(SkillTable.userId, userId),
                eq(SkillTable.visibility, "readonly"),
              ),
            ),
          );
        if (available.length !== skillIds.length) {
          throw new Error("One or more skills are unavailable");
        }
        if (
          agent.visibility !== "private" &&
          available.some((skill) => skill.visibility !== "readonly")
        ) {
          throw new Error("Shared agents may only use readonly skills");
        }
      }

      await tx
        .delete(AgentSkillTable)
        .where(eq(AgentSkillTable.agentId, agentId));
      if (skillIds.length > 0) {
        await tx.insert(AgentSkillTable).values(
          skillIds.map((skillId, position) => ({
            id: generateUUID(),
            agentId,
            skillId,
            position,
          })),
        );
      }
    });
  },

  async addSkillToAgent(skillId, agentId, userId) {
    const current = await db
      .select({ skillId: AgentSkillTable.skillId })
      .from(AgentSkillTable)
      .innerJoin(AgentTable, eq(AgentSkillTable.agentId, AgentTable.id))
      .where(
        and(
          eq(AgentSkillTable.agentId, agentId),
          eq(AgentTable.userId, userId),
        ),
      )
      .orderBy(asc(AgentSkillTable.position));
    if (current.some((assignment) => assignment.skillId === skillId))
      return true;
    try {
      await this.replaceAgentSkills(agentId, userId, [
        ...current.map(({ skillId: id }) => id),
        skillId,
      ]);
      return true;
    } catch {
      return false;
    }
  },

  async removeSkillFromAgent(skillId, agentId, userId) {
    const current = await db
      .select({ skillId: AgentSkillTable.skillId })
      .from(AgentSkillTable)
      .innerJoin(AgentTable, eq(AgentSkillTable.agentId, AgentTable.id))
      .where(
        and(
          eq(AgentSkillTable.agentId, agentId),
          eq(AgentTable.userId, userId),
        ),
      )
      .orderBy(asc(AgentSkillTable.position));
    if (current.length === 0) return;
    await this.replaceAgentSkills(
      agentId,
      userId,
      current.map(({ skillId: id }) => id).filter((id) => id !== skillId),
    );
  },

  async selectAgentSkillAssignments(agentId, userId) {
    const rows = await db
      .select({
        id: SkillTable.id,
        name: SkillTable.name,
        description: SkillTable.description,
        icon: SkillTable.icon,
        license: SkillTable.license,
        compatibility: SkillTable.compatibility,
        metadata: SkillTable.metadata,
        provenance: SkillTable.provenance,
        allowedTools: SkillTable.allowedTools,
        userId: SkillTable.userId,
        visibility: SkillTable.visibility,
        archivedAt: SkillTable.archivedAt,
        createdAt: SkillTable.createdAt,
        updatedAt: SkillTable.updatedAt,
        position: AgentSkillTable.position,
      })
      .from(AgentSkillTable)
      .innerJoin(SkillTable, eq(AgentSkillTable.skillId, SkillTable.id))
      .innerJoin(AgentTable, eq(AgentSkillTable.agentId, AgentTable.id))
      .where(
        and(
          eq(AgentSkillTable.agentId, agentId),
          isNull(SkillTable.archivedAt),
          or(
            eq(AgentTable.userId, userId),
            ne(AgentTable.visibility, "private"),
          ),
          or(
            eq(SkillTable.userId, userId),
            eq(SkillTable.visibility, "readonly"),
          ),
        ),
      )
      .orderBy(asc(AgentSkillTable.position));
    if (rows.length === 0) return [];

    const fileRows = await db
      .select({
        skillId: SkillFileTable.skillId,
        path: SkillFileTable.path,
        mimeType: SkillFileTable.mimeType,
        size: SkillFileTable.size,
      })
      .from(SkillFileTable)
      .where(
        inArray(
          SkillFileTable.skillId,
          rows.map(({ id }) => id),
        ),
      )
      .orderBy(SkillFileTable.path);
    const filesBySkill = new Map<string, AgentSkillAssignment["files"]>();
    for (const file of fileRows) {
      const files = filesBySkill.get(file.skillId) ?? [];
      files.push({ path: file.path, mimeType: file.mimeType, size: file.size });
      filesBySkill.set(file.skillId, files);
    }

    return rows.map((row) => ({
      ...row,
      icon: row.icon ?? undefined,
      license: row.license ?? undefined,
      compatibility: row.compatibility ?? undefined,
      metadata: row.metadata ?? undefined,
      allowedTools: row.allowedTools ?? undefined,
      archivedAt: row.archivedAt ?? undefined,
      files: filesBySkill.get(row.id) ?? [],
    }));
  },

  async selectSkillsByAgentId(agentId, userId) {
    const results = await db
      .select({
        id: SkillTable.id,
        name: SkillTable.name,
        description: SkillTable.description,
        icon: SkillTable.icon,
        license: SkillTable.license,
        compatibility: SkillTable.compatibility,
        metadata: SkillTable.metadata,
        provenance: SkillTable.provenance,
        sourceCandidateId: SkillTable.sourceCandidateId,
        version: SkillTable.version,
        allowedTools: SkillTable.allowedTools,
        userId: SkillTable.userId,
        body: SkillTable.body,
        visibility: SkillTable.visibility,
        archivedAt: SkillTable.archivedAt,
        createdAt: SkillTable.createdAt,
        updatedAt: SkillTable.updatedAt,
      })
      .from(AgentSkillTable)
      .innerJoin(SkillTable, eq(AgentSkillTable.skillId, SkillTable.id))
      .innerJoin(AgentTable, eq(AgentSkillTable.agentId, AgentTable.id))
      .where(
        and(
          eq(AgentSkillTable.agentId, agentId),
          isNull(SkillTable.archivedAt),
          or(
            eq(AgentTable.userId, userId),
            ne(AgentTable.visibility, "private"),
          ),
          or(
            eq(SkillTable.userId, userId),
            eq(SkillTable.visibility, "readonly"),
          ),
        ),
      )
      .orderBy(asc(AgentSkillTable.position));
    const files = await loadFiles(results.map(({ id }) => id));
    return results.map((result) => toSkill(result, files.get(result.id) ?? []));
  },

  async selectSkillSummariesByAgentId(agentId, userId, limit) {
    return db
      .select({
        id: SkillTable.id,
        name: SkillTable.name,
        description: SkillTable.description,
      })
      .from(AgentSkillTable)
      .innerJoin(SkillTable, eq(AgentSkillTable.skillId, SkillTable.id))
      .innerJoin(AgentTable, eq(AgentSkillTable.agentId, AgentTable.id))
      .where(
        and(
          eq(AgentSkillTable.agentId, agentId),
          isNull(SkillTable.archivedAt),
          or(
            eq(AgentTable.userId, userId),
            ne(AgentTable.visibility, "private"),
          ),
          or(
            eq(SkillTable.userId, userId),
            eq(SkillTable.visibility, "readonly"),
          ),
        ),
      )
      .orderBy(asc(AgentSkillTable.position))
      .limit(Math.min(limit, MAX_SKILL_ASSIGNMENTS));
  },

  async selectSkillContentById(id, userId) {
    const [skill] = await db
      .select({ body: SkillTable.body })
      .from(SkillTable)
      .where(
        and(
          eq(SkillTable.id, id),
          isNull(SkillTable.archivedAt),
          or(
            eq(SkillTable.userId, userId),
            eq(SkillTable.visibility, "readonly"),
          ),
        ),
      );
    if (!skill) return null;
    const resources = await db
      .select({ path: SkillFileTable.path })
      .from(SkillFileTable)
      .where(eq(SkillFileTable.skillId, id))
      .orderBy(SkillFileTable.path);
    return { body: skill.body, resources: resources.map(({ path }) => path) };
  },

  async selectSkillFileByPath(id, path, userId) {
    const [file] = await db
      .select({ path: SkillFileTable.path, content: SkillFileTable.content })
      .from(SkillFileTable)
      .innerJoin(SkillTable, eq(SkillFileTable.skillId, SkillTable.id))
      .where(
        and(
          eq(SkillFileTable.skillId, id),
          eq(SkillFileTable.path, path),
          isNull(SkillTable.archivedAt),
          or(
            eq(SkillTable.userId, userId),
            eq(SkillTable.visibility, "readonly"),
          ),
        ),
      );
    return file ?? null;
  },

  async selectSkillFiles(id, userId) {
    const [skill] = await db
      .select({ id: SkillTable.id })
      .from(SkillTable)
      .where(
        and(
          eq(SkillTable.id, id),
          or(
            eq(SkillTable.userId, userId),
            and(
              eq(SkillTable.visibility, "readonly"),
              isNull(SkillTable.archivedAt),
            ),
          ),
        ),
      );
    if (!skill) return null;
    return (await loadFiles([id])).get(id) ?? [];
  },

  async upsertSkillFile(id, userId, file) {
    const input = SkillFileSchema.parse(file);
    return db.transaction(async (tx) => {
      const [skill] = await tx
        .select({ id: SkillTable.id })
        .from(SkillTable)
        .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId)));
      if (!skill) throw new Error("Skill not found");

      const normalized = normalizeFile(input);
      const existing = await tx
        .select({
          id: SkillFileTable.id,
          path: SkillFileTable.path,
          size: SkillFileTable.size,
        })
        .from(SkillFileTable)
        .where(eq(SkillFileTable.skillId, id));
      const replaced = existing.find(({ path }) => path === input.path);
      const totalSize = existing.reduce((sum, item) => sum + item.size, 0);
      if (!replaced && existing.length >= MAX_SKILL_FILES) {
        throw new Error("Skill file limit exceeded");
      }
      if (
        totalSize - (replaced?.size ?? 0) + normalized.size >
        MAX_SKILL_TOTAL_FILE_SIZE
      ) {
        throw new Error("Skill total file size limit exceeded");
      }

      if (replaced) {
        await tx
          .update(SkillFileTable)
          .set({
            content: normalized.content,
            mimeType: normalized.mimeType,
            size: normalized.size,
            updatedAt: new Date(),
          })
          .where(eq(SkillFileTable.id, replaced.id));
      } else {
        await tx.insert(SkillFileTable).values(fileValues(id, [normalized]));
      }
      await tx
        .update(SkillTable)
        .set({ updatedAt: new Date() })
        .where(eq(SkillTable.id, id));
      return normalized;
    });
  },

  async deleteSkillFile(id, userId, path) {
    const deleted = await db
      .delete(SkillFileTable)
      .where(
        and(
          eq(SkillFileTable.skillId, id),
          eq(SkillFileTable.path, path),
          inArray(
            SkillFileTable.skillId,
            db
              .select({ id: SkillTable.id })
              .from(SkillTable)
              .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, userId))),
          ),
        ),
      )
      .returning({ id: SkillFileTable.id });
    return deleted.length > 0;
  },

  async checkAccess(skillId, userId) {
    const [skill] = await db
      .select({ id: SkillTable.id })
      .from(SkillTable)
      .where(
        and(
          eq(SkillTable.id, skillId),
          isNull(SkillTable.archivedAt),
          or(
            eq(SkillTable.userId, userId),
            eq(SkillTable.visibility, "readonly"),
          ),
        ),
      );
    return !!skill;
  },
};
