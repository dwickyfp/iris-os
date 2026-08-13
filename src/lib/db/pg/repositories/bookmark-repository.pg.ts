import { and, eq } from "drizzle-orm";
import { pgDb as db } from "../db.pg";
import { BookmarkTable, AgentTable, SkillTable } from "../schema.pg";

type BookmarkItemType = "agent" | "workflow" | "skill";

export interface BookmarkRepository {
  createBookmark(
    userId: string,
    itemId: string,
    itemType: BookmarkItemType,
  ): Promise<void>;

  removeBookmark(
    userId: string,
    itemId: string,
    itemType: BookmarkItemType,
  ): Promise<void>;

  toggleBookmark(
    userId: string,
    itemId: string,
    itemType: BookmarkItemType,
    isCurrentlyBookmarked: boolean,
  ): Promise<boolean>;

  checkItemAccess(
    itemId: string,
    itemType: BookmarkItemType,
    userId: string,
  ): Promise<boolean>;
}

export const pgBookmarkRepository: BookmarkRepository = {
  async createBookmark(userId, itemId, itemType) {
    await db
      .insert(BookmarkTable)
      .values({
        userId,
        itemId,
        itemType,
      })
      .onConflictDoNothing();
  },

  async removeBookmark(userId, itemId, itemType) {
    await db
      .delete(BookmarkTable)
      .where(
        and(
          eq(BookmarkTable.userId, userId),
          eq(BookmarkTable.itemId, itemId),
          eq(BookmarkTable.itemType, itemType),
        ),
      );
  },

  async toggleBookmark(userId, itemId, itemType, isCurrentlyBookmarked) {
    if (isCurrentlyBookmarked) {
      await this.removeBookmark(userId, itemId, itemType);
      return false;
    } else {
      await this.createBookmark(userId, itemId, itemType);
      return true;
    }
  },

  async checkItemAccess(itemId, itemType, userId) {
    if (itemType === "agent") {
      const agent = await db
        .select()
        .from(AgentTable)
        .where(eq(AgentTable.id, itemId))
        .limit(1);

      if (!agent[0]) return false;

      // Can bookmark if it's public/readonly or if it's their own agent
      return (
        agent[0].visibility === "public" ||
        agent[0].visibility === "readonly" ||
        agent[0].userId === userId
      );
    }

    if (itemType === "skill") {
      const [skill] = await db
        .select({
          userId: SkillTable.userId,
          visibility: SkillTable.visibility,
        })
        .from(SkillTable)
        .where(eq(SkillTable.id, itemId))
        .limit(1);

      return (
        !!skill && (skill.userId === userId || skill.visibility === "readonly")
      );
    }

    // TODO: Add workflow access check when workflows support bookmarking
    return false;
  },
};
