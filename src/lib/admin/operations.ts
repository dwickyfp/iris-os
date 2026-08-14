import "server-only";

import { and, desc, eq, inArray, isNotNull, lt, or } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunTable,
  AutomationRunTable,
  IrisActivityEventTable,
  LearningCandidateTable,
  LearningPromotionAttemptTable,
  SkillTable,
} from "lib/db/pg/schema.pg";

const STALE_BEFORE_MS = 10 * 60 * 1_000;

export async function getOperationsDiagnostics() {
  const staleBefore = new Date(Date.now() - STALE_BEFORE_MS);
  const [
    activity,
    candidates,
    promotionAttempts,
    skills,
    automationRuns,
    agentRuns,
    pendingActivity,
  ] =
    await Promise.all([
      pgDb
        .select({
          id: IrisActivityEventTable.id,
          status: IrisActivityEventTable.processingStatus,
          attempts: IrisActivityEventTable.processingAttempts,
          createdAt: IrisActivityEventTable.createdAt,
        })
        .from(IrisActivityEventTable)
        .where(
          or(
            eq(IrisActivityEventTable.processingStatus, "failed"),
            and(
              eq(IrisActivityEventTable.processingStatus, "processing"),
              lt(IrisActivityEventTable.claimExpiresAt, new Date()),
            ),
          ),
        )
        .orderBy(desc(IrisActivityEventTable.createdAt))
        .limit(50),
      pgDb
        .select({
          id: LearningCandidateTable.id,
          status: LearningCandidateTable.status,
          candidateType: LearningCandidateTable.candidateType,
          evidenceCount: LearningCandidateTable.evidenceCount,
          errorCode: LearningCandidateTable.promotionErrorCode,
          updatedAt: LearningCandidateTable.updatedAt,
        })
        .from(LearningCandidateTable)
        .where(
          or(
            inArray(LearningCandidateTable.status, ["collecting", "processing"]),
            isNotNull(LearningCandidateTable.promotedId),
          ),
        )
        .orderBy(desc(LearningCandidateTable.updatedAt))
        .limit(50),
      pgDb
        .select({
          id: LearningPromotionAttemptTable.id,
          candidateId: LearningPromotionAttemptTable.candidateId,
          attempt: LearningPromotionAttemptTable.attempt,
          status: LearningPromotionAttemptTable.status,
          errorCode: LearningPromotionAttemptTable.errorCode,
          startedAt: LearningPromotionAttemptTable.startedAt,
        })
        .from(LearningPromotionAttemptTable)
        .where(
          inArray(LearningPromotionAttemptTable.status, ["failed", "running"]),
        )
        .orderBy(desc(LearningPromotionAttemptTable.startedAt))
        .limit(50),
      pgDb
        .select({
          id: SkillTable.id,
          sourceCandidateId: SkillTable.sourceCandidateId,
          archivedAt: SkillTable.archivedAt,
          updatedAt: SkillTable.updatedAt,
        })
        .from(SkillTable)
        .where(eq(SkillTable.provenance, "learned"))
        .orderBy(desc(SkillTable.updatedAt))
        .limit(50),
      pgDb
        .select({
          id: AutomationRunTable.id,
          status: AutomationRunTable.status,
          errorCode: AutomationRunTable.errorCode,
          createdAt: AutomationRunTable.createdAt,
        })
        .from(AutomationRunTable)
        .where(
          or(
            inArray(AutomationRunTable.status, [
              "failed",
              "timed_out",
              "retry_scheduled",
            ]),
            and(
              eq(AutomationRunTable.status, "running"),
              lt(AutomationRunTable.startedAt, staleBefore),
            ),
          ),
        )
        .orderBy(desc(AutomationRunTable.createdAt))
        .limit(50),
      pgDb
        .select({
          id: AgentRunTable.id,
          status: AgentRunTable.status,
          errorCode: AgentRunTable.errorCode,
          createdAt: AgentRunTable.createdAt,
        })
        .from(AgentRunTable)
        .where(
          or(
            inArray(AgentRunTable.status, ["failed", "timed_out"]),
            and(
              eq(AgentRunTable.status, "running"),
              lt(AgentRunTable.startedAt, staleBefore),
            ),
          ),
        )
        .orderBy(desc(AgentRunTable.createdAt))
        .limit(50),
      pgDb
        .select({
          id: IrisActivityEventTable.id,
          createdAt: IrisActivityEventTable.createdAt,
        })
        .from(IrisActivityEventTable)
        .where(eq(IrisActivityEventTable.processingStatus, "pending"))
        .orderBy(IrisActivityEventTable.createdAt)
        .limit(1),
    ]);

  return {
    summary: {
      failedOrStaleActivity: activity.length,
      activeLearningCandidates: candidates.filter(
        ({ status }) => status === "collecting" || status === "processing",
      ).length,
      failedPromotionAttempts: promotionAttempts.filter(
        ({ status }) => status === "failed",
      ).length,
      oldestPendingActivityAt: pendingActivity[0]?.createdAt ?? null,
    },
    activity,
    candidates,
    promotionAttempts,
    skills,
    automationRuns,
    agentRuns,
  };
}
