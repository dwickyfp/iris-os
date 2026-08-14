import { getSession } from "auth/server";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { canEditSkill } from "lib/auth/permissions";
import { pgDb } from "lib/db/pg/db.pg";
import { SkillRevisionTable, SkillTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";
import { generateUUID } from "lib/utils";

const RevisionSnapshotSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(1).max(1_024),
  body: z.string().min(1).max(102_400),
  allowedTools: z.array(z.string().min(1).max(255)).max(100).default([]),
});

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  const [skill] = await pgDb
    .select({ id: SkillTable.id })
    .from(SkillTable)
    .where(and(eq(SkillTable.id, id), eq(SkillTable.userId, session.user.id)));
  if (!skill)
    return Response.json({ error: "Skill not found" }, { status: 404 });
  const revisions = await pgDb
    .select()
    .from(SkillRevisionTable)
    .where(eq(SkillRevisionTable.skillId, id))
    .orderBy(asc(SkillRevisionTable.version));
  return Response.json(revisions);
}

export async function POST(request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await canEditSkill()))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const snapshot = RevisionSnapshotSchema.parse(await request.json());
  const revision = await pgDb.transaction(async (tx) => {
    const [skill] = await tx
      .select({ id: SkillTable.id })
      .from(SkillTable)
      .where(
        and(eq(SkillTable.id, id), eq(SkillTable.userId, session.user.id)),
      );
    if (!skill) return null;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
    const [latest] = await tx
      .select({ version: max(SkillRevisionTable.version) })
      .from(SkillRevisionTable)
      .where(eq(SkillRevisionTable.skillId, id));
    const [created] = await tx
      .insert(SkillRevisionTable)
      .values({
        id: generateUUID(),
        skillId: id,
        userId: session.user.id,
        version: (latest.version ?? 0) + 1,
        status: "proposed",
        snapshot,
      })
      .returning();
    return created;
  });
  if (!revision)
    return Response.json({ error: "Skill not found" }, { status: 404 });
  return Response.json(revision, { status: 201 });
}
