import { getSession } from "auth/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { buildRunProjection } from "lib/ai/runs/projection";
import { summarizeAgentRunStatuses } from "lib/ai/runs/status";
import { pgDb } from "lib/db/pg/db.pg";
import {
  AgentRunCheckpointTable,
  AgentRunJoinTable,
  AgentRunTable,
  DelegationRunTable,
} from "lib/db/pg/schema.pg";

export async function GET() {
  const session = await getSession();
  if (!session?.user.id)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  const runs = await pgDb
    .select()
    .from(AgentRunTable)
    .where(eq(AgentRunTable.userId, session.user.id))
    .orderBy(desc(AgentRunTable.createdAt))
    .limit(100);
  const delegations = await pgDb
    .select()
    .from(DelegationRunTable)
    .where(eq(DelegationRunTable.userId, session.user.id))
    .orderBy(desc(DelegationRunTable.createdAt))
    .limit(100);
  const checkpoints = await pgDb
    .select({
      parentRunId: AgentRunCheckpointTable.parentRunId,
      continuationKind: AgentRunCheckpointTable.continuationKind,
      goalRound: AgentRunCheckpointTable.goalRound,
      maxGoalRounds: AgentRunCheckpointTable.maxGoalRounds,
    })
    .from(AgentRunCheckpointTable)
    .innerJoin(
      AgentRunTable,
      eq(AgentRunTable.id, AgentRunCheckpointTable.parentRunId),
    )
    .where(eq(AgentRunTable.userId, session.user.id));
  const pendingJoins = await pgDb
    .select({ parentRunId: AgentRunJoinTable.parentRunId })
    .from(AgentRunJoinTable)
    .innerJoin(
      AgentRunTable,
      eq(AgentRunTable.id, AgentRunJoinTable.parentRunId),
    )
    .where(
      and(
        eq(AgentRunTable.userId, session.user.id),
        isNull(AgentRunJoinTable.completedAt),
      ),
    );
  const checkpointsByRun = new Map(
    checkpoints.map((checkpoint) => [checkpoint.parentRunId, checkpoint]),
  );
  const runsWithPendingJoins = new Set(
    pendingJoins.map((join) => join.parentRunId),
  );
  const roots = runs.filter((run) => run.parentRunId === null);
  return Response.json({
    roots,
    runs,
    delegations,
    summary: summarizeAgentRunStatuses(runs),
    projections: roots.map((run) => {
      const checkpoint = checkpointsByRun.get(run.id);
      return {
        runId: run.id,
        maxGoalRounds: checkpoint?.maxGoalRounds ?? null,
        canSteer:
          run.status === "waiting_external" &&
          checkpoint?.continuationKind === "goal" &&
          !runsWithPendingJoins.has(run.id),
        ...buildRunProjection({
          run,
          goalRound: checkpoint?.goalRound,
          revision: run.goalRevision,
          children: runs
            .filter((child) => child.parentRunId === run.id)
            .map((child) => ({ status: child.status })),
        }),
      };
    }),
  });
}
