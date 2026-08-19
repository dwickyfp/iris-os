import { and, asc, eq, or } from "drizzle-orm";
import { IrisActivityEventTable } from "lib/db/pg/schema.pg";
import type { ActivityDatabase } from "lib/ai/runtime/event-recorder";

type TrajectoryDatabase = ActivityDatabase & {
  select: () => any;
};

export function getRunTrajectory(
  database: TrajectoryDatabase,
  userId: string,
  runId: string,
) {
  return database
    .select()
    .from(IrisActivityEventTable)
    .where(
      and(
        eq(IrisActivityEventTable.userId, userId),
        or(
          eq(IrisActivityEventTable.trajectoryId, runId),
          eq(IrisActivityEventTable.runId, runId),
        ),
      ),
    )
    .orderBy(
      asc(IrisActivityEventTable.sequence),
      asc(IrisActivityEventTable.createdAt),
      asc(IrisActivityEventTable.id),
    );
}
