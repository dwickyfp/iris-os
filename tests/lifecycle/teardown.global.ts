import { config } from "dotenv";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  AgentSkillTable,
  AgentTable,
  BookmarkTable,
  ChatThreadTable,
  SessionTable,
  SkillTable,
  UserTable,
} from "../../src/lib/db/pg/schema.pg";

config();

const db = drizzle(process.env.POSTGRES_URL!);

async function cleanup() {
  console.log("Cleaning up test data...");

  try {
    // Skills tests use seeded users, so clean their prefixed records explicitly.
    const testSkills = await db
      .select({ id: SkillTable.id })
      .from(SkillTable)
      .where(like(SkillTable.name, "playwright-skill-%"));
    const testSkillIds = testSkills.map(({ id }) => id);

    const testAgents = await db
      .select({ id: AgentTable.id })
      .from(AgentTable)
      .where(like(AgentTable.name, "playwright-skill-agent-%"));
    const testAgentIds = testAgents.map(({ id }) => id);

    if (testSkillIds.length > 0 || testAgentIds.length > 0) {
      await db
        .delete(AgentSkillTable)
        .where(
          or(
            ...(testSkillIds.length > 0
              ? [inArray(AgentSkillTable.skillId, testSkillIds)]
              : []),
            ...(testAgentIds.length > 0
              ? [inArray(AgentSkillTable.agentId, testAgentIds)]
              : []),
          ),
        );
    }
    if (testAgentIds.length > 0) {
      await db.delete(AgentTable).where(inArray(AgentTable.id, testAgentIds));
    }
    if (testSkillIds.length > 0) {
      await db
        .delete(BookmarkTable)
        .where(
          and(
            eq(BookmarkTable.itemType, "skill"),
            inArray(BookmarkTable.itemId, testSkillIds),
          ),
        );
      await db.delete(SkillTable).where(inArray(SkillTable.id, testSkillIds));
    }

    // Clean up only dynamically created test users (not seeded ones)
    // Preserve our seeded test users in @test-seed.local domain
    const testEmailPatterns = [
      "%playwright%", // Dynamically created playwright users
      "%@example.com%", // Test signup users
      "%@temp-test.%", // Temporary test users
    ];

    // First, get all test users
    const testUsers = await db
      .select({ id: UserTable.id })
      .from(UserTable)
      .where(
        or(
          ...testEmailPatterns.map((pattern) => like(UserTable.email, pattern)),
        ),
      );

    console.log(`Found ${testUsers.length} test users to clean up`);

    // Delete in reverse order due to foreign key constraints
    for (const user of testUsers) {
      console.log(`Cleaning up user: ${user.id}`);

      // Delete chat threads
      await db
        .delete(ChatThreadTable)
        .where(eq(ChatThreadTable.userId, user.id));

      // Delete bookmarks
      await db.delete(BookmarkTable).where(eq(BookmarkTable.userId, user.id));

      // Delete agents
      await db.delete(AgentTable).where(eq(AgentTable.userId, user.id));

      // Delete sessions
      await db.delete(SessionTable).where(eq(SessionTable.userId, user.id));

      // Delete user
      await db.delete(UserTable).where(eq(UserTable.id, user.id));
    }

    console.log("Test data cleaned up successfully");
  } catch (error) {
    console.error("Error cleaning up test data:", error);
  }
}

export default cleanup;
