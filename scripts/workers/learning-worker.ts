import type PgBoss from "pg-boss";
import { z } from "zod";
import { and, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ACTIVITY_PROCESS_QUEUE } from "lib/activity/queue";
import { pgDb } from "lib/db/pg/db.pg";
import {
  IrisActivityEventTable,
  LearningCandidateTable,
  LearningPromotionAttemptTable,
  SkillRevisionTable,
  SkillTable,
} from "lib/db/pg/schema.pg";
import {
  LEARNING_PROMOTION_QUEUE,
  LEARNING_PROMOTION_SWEEP_QUEUE,
} from "lib/learning/queue";
import { canAutoPromoteSkill } from "lib/learning/policy";
import { getLearningSettings } from "lib/learning/settings";
import { generateUUID } from "lib/utils";

const CLAIM_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 8;

const LearnedSkillPayloadSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().min(1).max(1_024),
  body: z.string().min(1).max(102_400),
  allowedTools: z.array(z.string()).max(0).default([]),
  revisesSkillId: z.string().uuid().optional(),
  nextVersion: z.number().int().min(2).optional(),
});

async function claimCandidate(candidateId: string) {
  const now = new Date();
  const [candidate] = await pgDb
    .update(LearningCandidateTable)
    .set({
      status: "processing",
      promotionClaimedAt: now,
      promotionClaimExpiresAt: new Date(now.getTime() + CLAIM_MS),
      promotionAttempts: sql`${LearningCandidateTable.promotionAttempts} + 1`,
      promotionErrorCode: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(LearningCandidateTable.id, candidateId),
        eq(LearningCandidateTable.candidateType, "skill"),
        eq(LearningCandidateTable.status, "pending"),
        lt(LearningCandidateTable.promotionAttempts, MAX_ATTEMPTS),
        or(
          isNull(LearningCandidateTable.promotionNextAttemptAt),
          lte(LearningCandidateTable.promotionNextAttemptAt, now),
        ),
      ),
    )
    .returning();
  return candidate;
}

async function insertEvent(input: {
  userId: string;
  candidateId: string;
  scopeType: "global" | "workspace" | "task" | "agent";
  scopeId: string | null;
  eventType:
    | "learning.promotion_started"
    | "learning.promotion_failed"
    | "learning.skill_activated";
  payload?: Record<string, unknown>;
}) {
  const [event] = await pgDb
    .insert(IrisActivityEventTable)
    .values({
      id: generateUUID(),
      userId: input.userId,
      actorType: "system",
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      eventType: input.eventType,
      subjectType: "learning_candidate",
      subjectId: input.candidateId,
      payload: input.payload ?? {},
      idempotencyKey: `${input.eventType}:${input.candidateId}`,
    })
    .onConflictDoNothing()
    .returning({ id: IrisActivityEventTable.id });
  return event?.id;
}

async function promoteCandidate(candidateId: string, boss: PgBoss) {
  const candidate = await claimCandidate(candidateId);
  if (!candidate) return;
  const attempt = candidate.promotionAttempts;
  await pgDb.insert(LearningPromotionAttemptTable).values({
    id: generateUUID(),
    candidateId: candidate.id,
    attempt,
    status: "running",
  });
  const startedEventId = await insertEvent({
    userId: candidate.userId,
    candidateId: candidate.id,
    scopeType: candidate.scopeType,
    scopeId: candidate.scopeId,
    eventType: "learning.promotion_started",
  });
  if (startedEventId)
    await boss.send(ACTIVITY_PROCESS_QUEUE, { eventId: startedEventId });

  try {
    const settings = await getLearningSettings(candidate.userId);
    if (
      !canAutoPromoteSkill({
        ...settings,
        evidenceCount: candidate.evidenceCount,
        successfulOutcomeCount: candidate.evidenceCount,
      }) ||
      !settings.allowedScopes.includes(candidate.scopeType)
    ) {
      await pgDb.transaction(async (tx) => {
        await tx
          .update(LearningCandidateTable)
          .set({
            status: "collecting",
            promotionClaimedAt: null,
            promotionClaimExpiresAt: null,
            resolutionReason: "policy_or_evidence_not_satisfied",
            updatedAt: new Date(),
          })
          .where(eq(LearningCandidateTable.id, candidate.id));
        await tx
          .update(LearningPromotionAttemptTable)
          .set({ status: "superseded", completedAt: new Date() })
          .where(
            and(
              eq(LearningPromotionAttemptTable.candidateId, candidate.id),
              eq(LearningPromotionAttemptTable.attempt, attempt),
            ),
          );
      });
      return;
    }

    const payload = LearnedSkillPayloadSchema.parse(candidate.proposedPayload);
    const promoted = await pgDb.transaction(async (tx) => {
      let skill: typeof SkillTable.$inferSelect | undefined;
      if (payload.revisesSkillId) {
        [skill] = await tx
          .select()
          .from(SkillTable)
          .where(
            and(
              eq(SkillTable.id, payload.revisesSkillId),
              eq(SkillTable.userId, candidate.userId),
              eq(SkillTable.provenance, "learned"),
            ),
          );
        if (!skill || payload.nextVersion !== skill.version + 1)
          throw new Error("LEARNED_SKILL_REVISION_CONFLICT");
        [skill] = await tx
          .update(SkillTable)
          .set({
            description: payload.description,
            body: payload.body,
            allowedTools: [],
            sourceCandidateId: candidate.id,
            version: payload.nextVersion,
            archivedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(SkillTable.id, skill.id))
          .returning();
      } else {
        [skill] = await tx
          .insert(SkillTable)
          .values({
            id: generateUUID(),
            userId: candidate.userId,
            name: payload.name,
            description: payload.description,
            body: payload.body,
            allowedTools: [],
            visibility: "private",
            provenance: "learned",
            sourceCandidateId: candidate.id,
          })
          .onConflictDoNothing()
          .returning();
        if (!skill) {
          [skill] = await tx
            .select()
            .from(SkillTable)
            .where(
              and(
                eq(SkillTable.userId, candidate.userId),
                eq(SkillTable.name, payload.name),
                eq(SkillTable.sourceCandidateId, candidate.id),
              ),
            );
        }
      }
      if (!skill) throw new Error("LEARNED_SKILL_NAME_CONFLICT");
      await tx
        .insert(SkillRevisionTable)
        .values({
          id: generateUUID(),
          skillId: skill.id,
          sourceCandidateId: candidate.id,
          userId: candidate.userId,
          version: skill.version,
          status: "approved",
          snapshot: { ...payload, allowedTools: [] },
          reviewedAt: new Date(),
        })
        .onConflictDoNothing();
      await tx
        .update(LearningCandidateTable)
        .set({
          status: "confirmed",
          promotedType: "skill",
          promotedId: skill.id,
          reviewedAt: new Date(),
          promotionClaimedAt: null,
          promotionClaimExpiresAt: null,
          promotionNextAttemptAt: null,
          promotionErrorCode: null,
          resolutionReason: "safe_background_promotion",
          updatedAt: new Date(),
        })
        .where(eq(LearningCandidateTable.id, candidate.id));
      await tx
        .update(LearningPromotionAttemptTable)
        .set({ status: "succeeded", completedAt: new Date() })
        .where(
          and(
            eq(LearningPromotionAttemptTable.candidateId, candidate.id),
            eq(LearningPromotionAttemptTable.attempt, attempt),
          ),
        );
      return skill;
    });
    const activatedEventId = await insertEvent({
      userId: candidate.userId,
      candidateId: candidate.id,
      scopeType: candidate.scopeType,
      scopeId: candidate.scopeId,
      eventType: "learning.skill_activated",
      payload: { toStatus: "active" },
    });
    if (activatedEventId)
      await boss.send(ACTIVITY_PROCESS_QUEUE, { eventId: activatedEventId });
    return promoted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = message.startsWith("LEARNED_")
      ? message.slice(0, 120)
      : "LEARNING_PROMOTION_FAILED";
    const delaySeconds = Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
    await pgDb.transaction(async (tx) => {
      await tx
        .update(LearningCandidateTable)
        .set({
          status: "pending",
          promotionClaimedAt: null,
          promotionClaimExpiresAt: null,
          promotionNextAttemptAt: new Date(Date.now() + delaySeconds * 1_000),
          promotionErrorCode: errorCode,
          updatedAt: new Date(),
        })
        .where(eq(LearningCandidateTable.id, candidate.id));
      await tx
        .update(LearningPromotionAttemptTable)
        .set({
          status: "failed",
          errorCode,
          error: message.slice(0, 2_000),
          completedAt: new Date(),
        })
        .where(
          and(
            eq(LearningPromotionAttemptTable.candidateId, candidate.id),
            eq(LearningPromotionAttemptTable.attempt, attempt),
          ),
        );
    });
    const failedEventId = await insertEvent({
      userId: candidate.userId,
      candidateId: candidate.id,
      scopeType: candidate.scopeType,
      scopeId: candidate.scopeId,
      eventType: "learning.promotion_failed",
      payload: { errorCode },
    });
    if (failedEventId)
      await boss.send(ACTIVITY_PROCESS_QUEUE, { eventId: failedEventId });
    throw error;
  }
}

export async function registerLearningWorkers(boss: PgBoss) {
  await boss.createQueue(LEARNING_PROMOTION_QUEUE);
  await boss.createQueue(LEARNING_PROMOTION_SWEEP_QUEUE);
  await boss.work<{ candidateId: string }>(
    LEARNING_PROMOTION_QUEUE,
    { batchSize: 2 },
    async (jobs) => {
      for (const job of jobs) await promoteCandidate(job.data.candidateId, boss);
    },
  );
  await boss.work(LEARNING_PROMOTION_SWEEP_QUEUE, async () => {
    const now = new Date();
    await pgDb
      .update(LearningCandidateTable)
      .set({
        status: "pending",
        promotionClaimedAt: null,
        promotionClaimExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(LearningCandidateTable.status, "processing"),
          lt(LearningCandidateTable.promotionClaimExpiresAt, now),
        ),
      );
    const candidates = await pgDb
      .select({ id: LearningCandidateTable.id })
      .from(LearningCandidateTable)
      .where(
        and(
          eq(LearningCandidateTable.candidateType, "skill"),
          eq(LearningCandidateTable.status, "pending"),
          lt(LearningCandidateTable.promotionAttempts, MAX_ATTEMPTS),
          or(
            isNull(LearningCandidateTable.promotionNextAttemptAt),
            lte(LearningCandidateTable.promotionNextAttemptAt, now),
          ),
        ),
      )
      .limit(100);
    for (const candidate of candidates)
      await boss.send(
        LEARNING_PROMOTION_QUEUE,
        { candidateId: candidate.id },
        { singletonKey: candidate.id },
      );
  });
  await boss.schedule(LEARNING_PROMOTION_SWEEP_QUEUE, "*/5 * * * *", {});
}
