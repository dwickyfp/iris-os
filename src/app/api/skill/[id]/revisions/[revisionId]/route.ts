import { getSession } from "auth/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { canEditSkill } from "lib/auth/permissions";
import { pgDb } from "lib/db/pg/db.pg";
import { SkillRevisionTable, SkillTable } from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";

const ReviewSchema = z.object({ action: z.enum(["approve", "reject"]) });
const SnapshotSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1_024),
  body: z.string().min(1).max(102_400),
  allowedTools: z.array(z.string()).max(100).default([]),
});

type Context = {
  params: Promise<{ id: string; revisionId: string }>;
};

export async function PATCH(request: Request, { params }: Context) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  if (!(await canEditSkill()))
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const input = ReviewSchema.parse(await request.json());
  const { id, revisionId } = await params;
  const reviewed = await pgDb.transaction(async (tx) => {
    const [revision] = await tx
      .select()
      .from(SkillRevisionTable)
      .where(
        and(
          eq(SkillRevisionTable.id, revisionId),
          eq(SkillRevisionTable.skillId, id),
          eq(SkillRevisionTable.userId, session.user.id),
          eq(SkillRevisionTable.status, "proposed"),
        ),
      );
    if (!revision) return null;
    if (input.action === "approve") {
      const snapshot = SnapshotSchema.parse(revision.snapshot);
      const [updated] = await tx
        .update(SkillTable)
        .set({ ...snapshot, version: revision.version, updatedAt: new Date() })
        .where(
          and(eq(SkillTable.id, id), eq(SkillTable.userId, session.user.id)),
        )
        .returning({ id: SkillTable.id });
      if (!updated) return null;
    }
    const [result] = await tx
      .update(SkillRevisionTable)
      .set({
        status: input.action === "approve" ? "approved" : "rejected",
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(SkillRevisionTable.id, revision.id),
          eq(SkillRevisionTable.status, "proposed"),
        ),
      )
      .returning();
    return result;
  });
  if (!reviewed)
    return Response.json(
      { error: "Proposed revision not found" },
      { status: 404 },
    );
  return Response.json(reviewed);
}
