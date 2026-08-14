import { getSession } from "auth/server";
import { LearningSettingsUpdateSchema } from "app-types/learning";
import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { LearningSettingTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";

const defaults = {
  enabled: true,
  allowedScopes: ["global", "workspace", "task", "agent"] as const,
  allowedCategories: ["memory", "skill", "automation"] as const,
  retentionDays: 90,
  autonomyLevel: 1,
};

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const [settings] = await pgDb
    .select()
    .from(LearningSettingTable)
    .where(eq(LearningSettingTable.userId, session.user.id));
  return Response.json(settings ?? defaults);
}

export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const input = LearningSettingsUpdateSchema.parse(await request.json());
  const [current] = await pgDb
    .select()
    .from(LearningSettingTable)
    .where(eq(LearningSettingTable.userId, session.user.id));
  const values = { ...defaults, ...current, ...input, updatedAt: new Date() };
  const [settings] = await pgDb
    .insert(LearningSettingTable)
    .values({ ...values, userId: session.user.id })
    .onConflictDoUpdate({
      target: LearningSettingTable.userId,
      set: values,
    })
    .returning();
  return Response.json(settings);
}
