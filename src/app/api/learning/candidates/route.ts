import { getSession } from "auth/server";
import { and, desc, eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import {
  LearningCandidateTable,
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
  return Response.json(rows);
}
