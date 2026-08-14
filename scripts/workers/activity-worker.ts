import { createHash } from "node:crypto";
import type PgBoss from "pg-boss";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  ACTIVITY_PROCESS_QUEUE,
  ACTIVITY_SWEEP_QUEUE,
} from "lib/activity/queue";
import { pgDb } from "lib/db/pg/db.pg";
import {
  IrisActivityEventTable,
  LearningCandidateTable,
  LearningObservationTable,
} from "lib/db/pg/schema.pg";
import { generateUUID } from "lib/utils";

function candidateFromEvent(event: typeof IrisActivityEventTable.$inferSelect) {
  const text = String(event.payload.userText ?? "").trim();
  if (!text || !/(aku|saya|gue|tolong|jangan|prefer|selalu)/i.test(text))
    return null;
  const summary = text.slice(0, 2_000);
  const suppressionKey = createHash("sha256")
    .update(
      `${event.scopeType}:${event.scopeId ?? ""}:${summary.toLowerCase()}`,
    )
    .digest("hex");
  const candidateType =
    /\b(setiap|tiap|harian|mingguan|jam\s+\d|every)\b/i.test(text)
      ? ("automation" as const)
      : /\b(langkah|prosedur|workflow|selalu lakukan|cara untuk)\b/i.test(text)
        ? ("skill" as const)
        : ("memory" as const);
  return { summary, suppressionKey, candidateType };
}

async function processEvent(eventId: string) {
  await pgDb.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(IrisActivityEventTable)
      .where(eq(IrisActivityEventTable.id, eventId))
      .limit(1);
    if (!event || event.processedAt) return;
    const candidate = candidateFromEvent(event);
    if (candidate) {
      const [observation] = await tx
        .insert(LearningObservationTable)
        .values({
          id: generateUUID(),
          eventId: event.id,
          userId: event.userId,
          scopeType: event.scopeType,
          scopeId: event.scopeId,
          observationType: "durable_statement",
          summary: candidate.summary,
          evidence: { eventId: event.id, threadId: event.threadId },
          confidence: 72,
        })
        .onConflictDoUpdate({
          target: [
            LearningObservationTable.eventId,
            LearningObservationTable.observationType,
          ],
          set: { summary: candidate.summary },
        })
        .returning();
      const [suppressed] = await tx
        .select({ id: LearningCandidateTable.id })
        .from(LearningCandidateTable)
        .where(
          and(
            eq(LearningCandidateTable.userId, event.userId),
            eq(LearningCandidateTable.suppressionKey, candidate.suppressionKey),
            eq(LearningCandidateTable.status, "ignored"),
          ),
        )
        .limit(1);
      if (!suppressed)
        await tx
          .insert(LearningCandidateTable)
          .values({
            id: generateUUID(),
            userId: event.userId,
            observationId: observation.id,
            scopeType: event.scopeType,
            scopeId: event.scopeId,
            candidateType: candidate.candidateType,
            title: candidate.summary.slice(0, 240),
            proposedPayload:
              candidate.candidateType === "skill"
                ? {
                    name: `learned-${candidate.suppressionKey.slice(0, 12)}`,
                    description: candidate.summary.slice(0, 1_024),
                    body: `# Learned procedure\n\n${candidate.summary}`,
                    allowedTools: [],
                  }
                : candidate.candidateType === "automation"
                  ? {
                      name: candidate.summary.slice(0, 160),
                      triggerType: "schedule",
                      cron: "0 9 * * *",
                      timezone: "UTC",
                      targetType: "agent",
                    }
                  : {
                      kind: "semantic",
                      content: candidate.summary,
                    },
            confidence: 72,
            suppressionKey: candidate.suppressionKey,
          })
          .onConflictDoNothing();
    }
    await tx
      .update(IrisActivityEventTable)
      .set({
        processedAt: new Date(),
        processingAttempts: sql`${IrisActivityEventTable.processingAttempts} + 1`,
      })
      .where(eq(IrisActivityEventTable.id, event.id));
  });
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
    const events = await pgDb
      .select({ id: IrisActivityEventTable.id })
      .from(IrisActivityEventTable)
      .where(isNull(IrisActivityEventTable.processedAt))
      .limit(500);
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
