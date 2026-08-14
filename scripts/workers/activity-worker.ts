import type PgBoss from "pg-boss";
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { ActivityEventType } from "app-types/activity";
import {
  ACTIVITY_PROCESS_QUEUE,
  ACTIVITY_SWEEP_QUEUE,
} from "lib/activity/queue";
import { pgDb } from "lib/db/pg/db.pg";
import {
  IrisActivityEventTable,
  LearningCandidateEvidenceTable,
  LearningCandidateTable,
  LearningObservationTable,
  LearningSettingTable,
  LearningSuppressionTable,
  SkillTable,
} from "lib/db/pg/schema.pg";
import {
  extractLearningSignal,
  isLearningAllowed,
  learningConfidence,
  learningSuppressionKey,
  procedureSimilarity,
} from "lib/learning/policy";
import { generateUUID } from "lib/utils";
import { enqueueLearningPromotion } from "lib/learning/queue";

const CLAIM_MS = 5 * 60 * 1_000;
const MAX_ATTEMPTS = 8;

async function claimEvent(eventId: string) {
  const now = new Date();
  const [event] = await pgDb
    .update(IrisActivityEventTable)
    .set({
      processingStatus: "processing",
      claimedAt: now,
      claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
      processingAttempts: sql`${IrisActivityEventTable.processingAttempts} + 1`,
      lastError: null,
    })
    .where(
      and(
        eq(IrisActivityEventTable.id, eventId),
        lt(IrisActivityEventTable.processingAttempts, MAX_ATTEMPTS),
        or(
          and(
            eq(IrisActivityEventTable.processingStatus, "pending"),
            or(
              isNull(IrisActivityEventTable.nextAttemptAt),
              lte(IrisActivityEventTable.nextAttemptAt, now),
            ),
          ),
          and(
            eq(IrisActivityEventTable.processingStatus, "failed"),
            or(
              isNull(IrisActivityEventTable.nextAttemptAt),
              lte(IrisActivityEventTable.nextAttemptAt, now),
            ),
          ),
          and(
            eq(IrisActivityEventTable.processingStatus, "processing"),
            lt(IrisActivityEventTable.claimExpiresAt, now),
          ),
        ),
      ),
    )
    .returning();
  return event;
}

async function processClaimedEvent(
  event: typeof IrisActivityEventTable.$inferSelect,
) {
  let promotionCandidateId: string | undefined;
  await pgDb.transaction(async (tx) => {
    const signal = extractLearningSignal({
      eventType: event.eventType as ActivityEventType,
      payload: event.payload,
    });
    if (signal) {
      const [storedSettings] = await tx
        .select()
        .from(LearningSettingTable)
        .where(eq(LearningSettingTable.userId, event.userId));
      const settings = storedSettings ?? {
        enabled: true,
        allowedScopes: ["global", "workspace", "task", "agent"] as const,
        allowedCategories: ["memory", "skill"] as const,
      };
      if (
        !isLearningAllowed({
          enabled: settings.enabled,
          allowedScopes: [...settings.allowedScopes],
          allowedCategories: [...settings.allowedCategories],
          scopeType: event.scopeType,
          candidateType: signal.candidateType,
        })
      ) {
        await markProcessed(tx, event.id);
        return;
      }
      const suppressionKey = learningSuppressionKey({
        userId: event.userId,
        scopeType: event.scopeType,
        scopeId: event.scopeId,
        candidateType: signal.candidateType,
        normalizedPattern: signal.normalizedPattern,
      });
      const [observation] = await tx
        .insert(LearningObservationTable)
        .values({
          id: generateUUID(),
          eventId: event.id,
          userId: event.userId,
          scopeType: event.scopeType,
          scopeId: event.scopeId,
          observationType: signal.observationType,
          summary: signal.summary,
          evidence: { eventId: event.id, threadId: event.threadId },
          confidence: learningConfidence(1),
        })
        .onConflictDoUpdate({
          target: [
            LearningObservationTable.eventId,
            LearningObservationTable.observationType,
          ],
          set: { summary: signal.summary, confidence: learningConfidence(1) },
        })
        .returning();
      const [suppressed] = await tx
        .select({ id: LearningSuppressionTable.id })
        .from(LearningSuppressionTable)
        .where(
          and(
            eq(LearningSuppressionTable.userId, event.userId),
            eq(LearningSuppressionTable.scopeType, event.scopeType),
            event.scopeId
              ? eq(LearningSuppressionTable.scopeId, event.scopeId)
              : isNull(LearningSuppressionTable.scopeId),
            eq(LearningSuppressionTable.candidateType, signal.candidateType),
            eq(LearningSuppressionTable.suppressionKey, suppressionKey),
            or(
              isNull(LearningSuppressionTable.expiresAt),
              gt(LearningSuppressionTable.expiresAt, new Date()),
            ),
          ),
        )
        .limit(1);
      if (!suppressed) {
        let correctedSkill:
          | { id: string; name: string; version: number }
          | undefined;
        if (event.eventType === "chat.correction") {
          const activeLearned = await tx
            .select({
              candidateId: LearningCandidateTable.id,
              title: LearningCandidateTable.title,
              id: SkillTable.id,
              name: SkillTable.name,
              version: SkillTable.version,
            })
            .from(LearningCandidateTable)
            .innerJoin(
              SkillTable,
              eq(SkillTable.sourceCandidateId, LearningCandidateTable.id),
            )
            .where(
              and(
                eq(LearningCandidateTable.userId, event.userId),
                eq(LearningCandidateTable.candidateType, "skill"),
                eq(LearningCandidateTable.status, "confirmed"),
                eq(LearningCandidateTable.scopeType, event.scopeType),
                event.scopeId
                  ? eq(LearningCandidateTable.scopeId, event.scopeId)
                  : isNull(LearningCandidateTable.scopeId),
                isNull(SkillTable.archivedAt),
              ),
            );
          const match = activeLearned
            .map((item) => ({
              ...item,
              similarity: procedureSimilarity(signal.summary, item.title),
            }))
            .filter((item) => item.similarity >= 0.45)
            .sort((a, b) => b.similarity - a.similarity)[0];
          if (match) {
            correctedSkill = {
              id: match.id,
              name: match.name,
              version: match.version,
            };
            await tx
              .update(SkillTable)
              .set({ archivedAt: new Date(), updatedAt: new Date() })
              .where(eq(SkillTable.id, match.id));
            await tx
              .update(LearningCandidateTable)
              .set({
                status: "superseded",
                resolutionReason: "explicit_correction_received",
                updatedAt: new Date(),
              })
              .where(eq(LearningCandidateTable.id, match.candidateId));
            await tx
              .insert(IrisActivityEventTable)
              .values({
                id: generateUUID(),
                userId: event.userId,
                actorType: "system",
                scopeType: event.scopeType,
                scopeId: event.scopeId,
                eventType: "learning.skill_deactivated",
                subjectType: "skill",
                subjectId: match.id,
                payload: { toStatus: "inactive" },
                requestId: event.requestId,
                runId: event.runId,
                threadId: event.threadId,
                idempotencyKey: `learning.skill_deactivated:${match.id}:${event.id}`,
              })
              .onConflictDoNothing();
          }
        }
        const [existing] = await tx
          .select()
          .from(LearningCandidateTable)
          .where(
            and(
              eq(LearningCandidateTable.userId, event.userId),
              eq(LearningCandidateTable.suppressionKey, suppressionKey),
              inArray(LearningCandidateTable.status, [
                "collecting",
                "pending",
                "confirmed",
              ]),
            ),
          )
          .limit(1);
        const candidate =
          existing ??
          (
            await tx
              .insert(LearningCandidateTable)
              .values({
                id: generateUUID(),
                userId: event.userId,
                observationId: observation.id,
                scopeType: event.scopeType,
                scopeId: event.scopeId,
                candidateType: signal.candidateType,
                title: signal.summary.slice(0, 240),
                proposedPayload:
                  signal.candidateType === "skill"
                    ? {
                        name:
                          correctedSkill?.name ??
                          `learned-${suppressionKey.slice(0, 12)}`,
                        description: signal.summary.slice(0, 1_024),
                        body: `# Learned procedure\n\n${signal.summary}`,
                        allowedTools: [],
                        ...(correctedSkill
                          ? {
                              revisesSkillId: correctedSkill.id,
                              nextVersion: correctedSkill.version + 1,
                            }
                          : {}),
                      }
                    : signal.candidateType === "automation"
                      ? {
                          name: signal.summary.slice(0, 160),
                          triggerType: "schedule",
                          cron: "0 9 * * *",
                          timezone: "UTC",
                          targetType: "agent",
                        }
                      : { kind: "semantic", content: signal.summary },
                confidence: learningConfidence(1),
                suppressionKey,
                status: signal.threshold === 1 ? "pending" : "collecting",
              })
              .returning()
          )[0];
        await tx
          .insert(LearningCandidateEvidenceTable)
          .values({
            candidateId: candidate.id,
            observationId: observation.id,
          })
          .onConflictDoNothing();
        const [{ total }] = await tx
          .select({ total: count() })
          .from(LearningCandidateEvidenceTable)
          .where(eq(LearningCandidateEvidenceTable.candidateId, candidate.id));
        const nextStatus =
          candidate.status === "collecting" && total >= signal.threshold
            ? "pending"
            : candidate.status;
        await tx
          .update(LearningCandidateTable)
          .set({
            evidenceCount: total,
            confidence: learningConfidence({
              evidenceCount: total,
              ageDays: Math.floor(
                (Date.now() - candidate.firstObservedAt.getTime()) / 86_400_000,
              ),
              consistency: 1,
            }),
            lastObservedAt: new Date(),
            status: nextStatus,
            updatedAt: new Date(),
          })
          .where(eq(LearningCandidateTable.id, candidate.id));
        if (signal.candidateType === "skill" && nextStatus === "pending") {
          promotionCandidateId = candidate.id;
        }
      }
    }
    await markProcessed(tx, event.id);
  });
  return promotionCandidateId;
}

async function markProcessed(
  tx: Parameters<Parameters<typeof pgDb.transaction>[0]>[0],
  eventId: string,
) {
  await tx
    .update(IrisActivityEventTable)
    .set({
      processingStatus: "processed",
      processedAt: new Date(),
      claimExpiresAt: null,
      nextAttemptAt: null,
      lastError: null,
    })
    .where(
      and(
        eq(IrisActivityEventTable.id, eventId),
        eq(IrisActivityEventTable.processingStatus, "processing"),
      ),
    );
}

async function processEvent(eventId: string) {
  const event = await claimEvent(eventId);
  if (!event) return;
  try {
    const promotionCandidateId = await processClaimedEvent(event);
    if (promotionCandidateId) {
      await enqueueLearningPromotion(promotionCandidateId);
    }
  } catch (error) {
    const delaySeconds = Math.min(
      3_600,
      30 * 2 ** Math.max(0, event.processingAttempts - 1),
    );
    await pgDb
      .update(IrisActivityEventTable)
      .set({
        processingStatus: "failed",
        claimExpiresAt: null,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1_000),
        lastError: (error instanceof Error
          ? error.message
          : String(error)
        ).slice(0, 2_000),
      })
      .where(eq(IrisActivityEventTable.id, event.id));
    throw error;
  }
}

export async function registerActivityWorkers(boss: PgBoss) {
  await boss.createQueue(ACTIVITY_PROCESS_QUEUE);
  await boss.createQueue(ACTIVITY_SWEEP_QUEUE);
  await boss.work<{ eventId: string }>(
    ACTIVITY_PROCESS_QUEUE,
    { batchSize: 4 },
    async (jobs) => {
      for (const job of jobs) await processEvent(job.data.eventId);
    },
  );
  await boss.work(ACTIVITY_SWEEP_QUEUE, async () => {
    await pgDb
      .update(LearningCandidateTable)
      .set({ status: "pending", updatedAt: new Date() })
      .where(
        and(
          eq(LearningCandidateTable.status, "processing"),
          lt(
            LearningCandidateTable.updatedAt,
            new Date(Date.now() - 15 * 60 * 1_000),
          ),
        ),
      );
    const now = new Date();
    const events = await pgDb
      .select({ id: IrisActivityEventTable.id })
      .from(IrisActivityEventTable)
      .where(
        and(
          lt(IrisActivityEventTable.processingAttempts, MAX_ATTEMPTS),
          or(
            eq(IrisActivityEventTable.processingStatus, "pending"),
            and(
              eq(IrisActivityEventTable.processingStatus, "failed"),
              or(
                isNull(IrisActivityEventTable.nextAttemptAt),
                lte(IrisActivityEventTable.nextAttemptAt, now),
              ),
            ),
            and(
              eq(IrisActivityEventTable.processingStatus, "processing"),
              lt(IrisActivityEventTable.claimExpiresAt, now),
            ),
          ),
        ),
      )
      .limit(200);
    for (const event of events)
      await boss.send(
        ACTIVITY_PROCESS_QUEUE,
        { eventId: event.id },
        {
          singletonKey: event.id,
        },
      );
  });
  await boss.schedule(ACTIVITY_SWEEP_QUEUE, "*/5 * * * *", {});
}
