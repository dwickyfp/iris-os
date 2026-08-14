import { getSession } from "auth/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { pgDb } from "lib/db/pg/db.pg";
import {
  LearningCandidateTable,
  LearningFeedbackTable,
  LearningSettingTable,
  LearningSuppressionTable,
  SkillRevisionTable,
  SkillTable,
  AutomationTable,
} from "lib/db/pg/schema.pg";
import { memoryGraphRepository } from "lib/db/repository";
import { generateUUID } from "lib/utils";
import { resolveOwnedMemoryScope } from "lib/ai/memory/scope-server";
import { isV2FeatureEnabled } from "lib/feature-flags";

const ReviewSchema = z.object({
  action: z.enum(["confirm", "edit", "ignore", "change_scope"]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const input = ReviewSchema.parse(await request.json());
  const candidateId = (await params).id;
  const [candidate] = await pgDb
    .update(LearningCandidateTable)
    .set({ status: "processing", updatedAt: new Date() })
    .where(
      and(
        eq(LearningCandidateTable.id, candidateId),
        eq(LearningCandidateTable.userId, session.user.id),
        eq(LearningCandidateTable.status, "pending"),
      ),
    )
    .returning();
  if (!candidate)
    return Response.json(
      { error: "Candidate is not pending" },
      { status: 409 },
    );

  let promotedId: string | undefined;
  let insertedArtifact:
    | { type: "skill" | "automation"; id: string }
    | undefined;
  try {
    const proposed = { ...candidate.proposedPayload, ...input.payload };
    const nextScope =
      input.action === "change_scope"
        ? await resolveOwnedMemoryScope(session.user.id, {
            scopeType: z
              .enum(["global", "workspace", "task", "agent"])
              .parse(input.payload.scopeType),
            scopeId: z.string().uuid().nullable().parse(input.payload.scopeId),
          })
        : { scopeType: candidate.scopeType, scopeId: candidate.scopeId };
    if (input.action === "confirm" && candidate.candidateType === "memory") {
      const result = await memoryGraphRepository.curateClaim({
        userId: session.user.id,
        kind: z
          .enum([
            "identity",
            "preference",
            "semantic",
            "episodic",
            "decision",
            "procedure",
            "operational",
            "relationship",
            "goal",
          ])
          .parse(proposed.kind),
        content: z.string().min(1).max(2_000).parse(proposed.content),
        confidence: candidate.confidence / 100,
        provenance: "background_review",
        scope: nextScope,
      });
      promotedId = result.memoryId;
    } else if (
      input.action === "confirm" &&
      candidate.candidateType === "skill"
    ) {
      const [skill] = await pgDb
        .insert(SkillTable)
        .values({
          id: generateUUID(),
          userId: session.user.id,
          name: z
            .string()
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
            .max(64)
            .parse(proposed.name),
          description: z.string().min(1).max(1_024).parse(proposed.description),
          body: z.string().min(1).max(102_400).parse(proposed.body),
          allowedTools: z
            .array(z.string())
            .max(100)
            .parse(proposed.allowedTools ?? []),
          visibility: "private",
          provenance: "learned",
          sourceCandidateId: candidate.id,
        })
        .returning({ id: SkillTable.id });
      promotedId = skill.id;
      insertedArtifact = { type: "skill", id: skill.id };
    } else if (
      input.action === "confirm" &&
      candidate.candidateType === "automation"
    ) {
      const [automation] = await pgDb
        .insert(AutomationTable)
        .values({
          id: generateUUID(),
          userId: session.user.id,
          name: z.string().min(1).max(160).parse(proposed.name),
          triggerType: z
            .enum(["manual", "schedule"])
            .parse(proposed.triggerType),
          cron: z.string().min(5).max(120).optional().parse(proposed.cron),
          timezone: z
            .string()
            .min(1)
            .max(80)
            .parse(proposed.timezone ?? "UTC"),
          missedRunPolicy: "skip",
          targetType: z
            .enum(["workflow", "skill", "agent"])
            .parse(proposed.targetType),
          targetId: z.string().uuid().parse(proposed.targetId),
          approvalPolicy: z
            .enum(["always", "destructive_only", "never"])
            .parse(proposed.approvalPolicy ?? "always"),
          input: z.record(z.string(), z.unknown()).parse(proposed.input ?? {}),
        })
        .returning({ id: AutomationTable.id });
      promotedId = automation.id;
      insertedArtifact = { type: "automation", id: automation.id };
    }

    await pgDb.transaction(async (tx) => {
      if (input.action === "ignore") {
        const [settings] = await tx
          .select({ retentionDays: LearningSettingTable.retentionDays })
          .from(LearningSettingTable)
          .where(eq(LearningSettingTable.userId, session.user.id));
        const retentionDays = settings?.retentionDays ?? 90;
        await tx
          .insert(LearningSuppressionTable)
          .values({
            id: generateUUID(),
            userId: session.user.id,
            scopeType: candidate.scopeType,
            scopeId: candidate.scopeId,
            candidateType: candidate.candidateType,
            suppressionKey: candidate.suppressionKey,
            reason: "user_ignored",
            expiresAt: new Date(Date.now() + retentionDays * 86_400_000),
          })
          .onConflictDoUpdate({
            target: [
              LearningSuppressionTable.userId,
              LearningSuppressionTable.scopeType,
              LearningSuppressionTable.scopeId,
              LearningSuppressionTable.candidateType,
              LearningSuppressionTable.suppressionKey,
            ],
            set: {
              reason: "user_ignored",
              expiresAt: new Date(Date.now() + retentionDays * 86_400_000),
            },
          });
      }
      if (
        input.action === "confirm" &&
        candidate.candidateType === "skill" &&
        promotedId
      ) {
        await tx.insert(SkillRevisionTable).values({
          id: generateUUID(),
          skillId: promotedId,
          sourceCandidateId: candidate.id,
          userId: session.user.id,
          version: 1,
          status: "approved",
          snapshot: proposed,
          reviewedAt: new Date(),
        });
      }
      await tx.insert(LearningFeedbackTable).values({
        id: generateUUID(),
        candidateId: candidate.id,
        userId: session.user.id,
        action: input.action,
        payload: input.payload,
      });
      const [finalized] = await tx
        .update(LearningCandidateTable)
        .set({
          proposedPayload: proposed,
          scopeType: nextScope.scopeType,
          scopeId: nextScope.scopeId,
          status:
            input.action === "ignore"
              ? "ignored"
              : input.action === "confirm"
                ? "confirmed"
                : "pending",
          promotedType: promotedId ? candidate.candidateType : null,
          promotedId: promotedId ?? null,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(LearningCandidateTable.id, candidate.id),
            eq(LearningCandidateTable.status, "processing"),
          ),
        )
        .returning({ id: LearningCandidateTable.id });
      if (!finalized) throw new Error("Candidate review claim was lost");
    });
    return Response.json({ ok: true, promotedId });
  } catch (error) {
    if (insertedArtifact?.type === "skill") {
      await pgDb
        .delete(SkillTable)
        .where(eq(SkillTable.id, insertedArtifact.id));
    } else if (insertedArtifact?.type === "automation") {
      await pgDb
        .delete(AutomationTable)
        .where(eq(AutomationTable.id, insertedArtifact.id));
    }
    await pgDb
      .update(LearningCandidateTable)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(LearningCandidateTable.id, candidate.id),
          eq(LearningCandidateTable.status, "processing"),
        ),
      );
    throw error;
  }
}
