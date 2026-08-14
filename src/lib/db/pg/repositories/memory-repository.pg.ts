import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { generateUUID } from "lib/utils";
import type { UserMemory } from "app-types/memory";
import { pgDb as db } from "../db.pg";
import {
  MemoryEdgeTable,
  UserMemoryEventTable,
  UserMemoryTable,
} from "../schema.pg";

function toMemory(row: typeof UserMemoryTable.$inferSelect): UserMemory {
  return {
    ...row,
    confidence: row.confidence / 100,
    deletedAt: row.deletedAt ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    sourceThreadId: row.sourceThreadId ?? undefined,
    sourceMessageId: row.sourceMessageId ?? undefined,
  };
}

async function event(
  memory: typeof UserMemoryTable.$inferSelect,
  action: "create" | "update" | "supersede" | "delete" | "restore",
) {
  await db.insert(UserMemoryEventTable).values({
    id: generateUUID(),
    memoryId: memory.id,
    userId: memory.userId,
    action,
    snapshot: memory,
  });
}

export const pgMemoryRepository = {
  async list(userId: string) {
    const rows = await db
      .select()
      .from(UserMemoryTable)
      .where(
        and(
          eq(UserMemoryTable.userId, userId),
          isNull(UserMemoryTable.deletedAt),
        ),
      )
      .orderBy(desc(UserMemoryTable.updatedAt));
    return rows.map(toMemory);
  },
  async create(
    input: Omit<
      UserMemory,
      "id" | "version" | "createdAt" | "updatedAt" | "status"
    > & { status?: UserMemory["status"] },
  ) {
    const [memory] = await db
      .insert(UserMemoryTable)
      .values({
        ...input,
        id: generateUUID(),
        confidence: Math.round(input.confidence * 100),
        status: input.status ?? "active",
        version: 1,
      })
      .returning();
    await event(memory, "create");
    return toMemory(memory);
  },
  async update(
    id: string,
    userId: string,
    values: Partial<
      Pick<
        UserMemory,
        "content" | "kind" | "confidence" | "expiresAt" | "status"
      >
    >,
  ) {
    const [memory] = await db
      .update(UserMemoryTable)
      .set({
        ...values,
        ...(values.confidence === undefined
          ? {}
          : { confidence: Math.round(values.confidence * 100) }),
        version: sql`${UserMemoryTable.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(UserMemoryTable.id, id), eq(UserMemoryTable.userId, userId)),
      )
      .returning();
    if (!memory) throw new Error("Memory not found");
    await event(memory, "update");
    return toMemory(memory);
  },
  async remove(id: string, userId: string) {
    const [memory] = await db
      .update(UserMemoryTable)
      .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(UserMemoryTable.id, id), eq(UserMemoryTable.userId, userId)),
      )
      .returning();
    if (!memory) throw new Error("Memory not found");
    await event(memory, "delete");
    await db
      .update(MemoryEdgeTable)
      .set({ status: "deleted", validTo: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(MemoryEdgeTable.userId, userId),
          or(
            eq(MemoryEdgeTable.sourceId, id),
            eq(MemoryEdgeTable.targetId, id),
          ),
        ),
      );
  },
  async restore(id: string, userId: string) {
    const [memory] = await db
      .update(UserMemoryTable)
      .set({
        status: "active",
        deletedAt: null,
        version: sql`${UserMemoryTable.version} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(eq(UserMemoryTable.id, id), eq(UserMemoryTable.userId, userId)),
      )
      .returning();
    if (!memory) throw new Error("Memory not found");
    await event(memory, "restore");
    await db
      .update(MemoryEdgeTable)
      .set({ status: "active", validTo: null, updatedAt: new Date() })
      .where(
        and(
          eq(MemoryEdgeTable.userId, userId),
          or(
            eq(MemoryEdgeTable.sourceId, id),
            eq(MemoryEdgeTable.targetId, id),
          ),
        ),
      );
    return toMemory(memory);
  },
  async clear(userId: string) {
    const rows = await db
      .update(UserMemoryTable)
      .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(UserMemoryTable.userId, userId),
          isNull(UserMemoryTable.deletedAt),
        ),
      )
      .returning();
    await Promise.all(rows.map((memory) => event(memory, "delete")));
  },
};
