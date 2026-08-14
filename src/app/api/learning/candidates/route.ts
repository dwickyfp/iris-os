import { getSession } from "auth/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  LearningCandidateTable,
  LearningCandidateEvidenceTable,
  LearningObservationTable,
} from "lib/db/pg/schema.pg";
import { isV2FeatureEnabled } from "lib/feature-flags";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!isV2FeatureEnabled("learning"))
    return Response.json({ error: "Not found" }, { status: 404 });
  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  const rows = await pgDb
    .select({
      candidate: LearningCandidateTable,
      observation: LearningObservationTable,
    })
    .from(LearningCandidateTable)
    .innerJoin(
      LearningObservationTable,
      eq(LearningCandidateTable.observationId, LearningObservationTable.id),
    )
    .where(
      and(
        eq(LearningCandidateTable.userId, session.user.id),
        eq(LearningCandidateTable.status, status as any),
      ),
    )
    .orderBy(desc(LearningCandidateTable.createdAt));
  const candidateIds = rows.map(({ candidate }) => candidate.id);
  const evidence = candidateIds.length
    ? await pgDb
        .select({
          candidateId: LearningCandidateEvidenceTable.candidateId,
          observation: LearningObservationTable,
        })
        .from(LearningCandidateEvidenceTable)
        .innerJoin(
          LearningObservationTable,
          eq(
            LearningCandidateEvidenceTable.observationId,
            LearningObservationTable.id,
          ),
        )
        .where(
          inArray(LearningCandidateEvidenceTable.candidateId, candidateIds),
        )
    : [];
  return Response.json(
    rows.map((row) => ({
      ...row,
      evidence: evidence
        .filter((item) => item.candidateId === row.candidate.id)
        .map((item) => item.observation),
    })),
  );
}
