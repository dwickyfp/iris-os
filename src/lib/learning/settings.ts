import type { z } from "zod";
import { LearningSettingsSchema } from "app-types/learning";
import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { LearningSettingTable } from "lib/db/pg/schema.pg";

export const DEFAULT_LEARNING_SETTINGS = LearningSettingsSchema.parse({
  enabled: true,
  allowedScopes: ["global", "workspace", "task", "agent"],
  allowedCategories: ["memory", "skill"],
  retentionDays: 90,
  autonomyLevel: 1,
});

export type LearningSettings = z.output<typeof LearningSettingsSchema>;

export async function getLearningSettings(userId: string) {
  const [stored] = await pgDb
    .select()
    .from(LearningSettingTable)
    .where(eq(LearningSettingTable.userId, userId));
  return LearningSettingsSchema.parse(stored ?? DEFAULT_LEARNING_SETTINGS);
}

export async function updateLearningSettings(
  userId: string,
  update: Partial<LearningSettings>,
) {
  const current = await getLearningSettings(userId);
  const values = LearningSettingsSchema.parse({ ...current, ...update });
  const [settings] = await pgDb
    .insert(LearningSettingTable)
    .values({ userId, ...values, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: LearningSettingTable.userId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return settings;
}
