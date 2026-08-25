import "server-only";

import { eq } from "drizzle-orm";
import { enqueueRunInbox } from "lib/ai/runs/run-inbox.server";
import { pgDb } from "lib/db/pg/db.pg";
import { AgentRunTable } from "lib/db/pg/schema.pg";
import type { RunInbox, RunInboxCompletion } from "./contracts";
import { pgDurableJobRepository } from "./repository.pg";
import { createDurableJobService } from "./service";

export const serverRunInbox: RunInbox = {
  async injectCompletion(completion: RunInboxCompletion) {
    const [run] = await pgDb
      .select({
        userId: AgentRunTable.userId,
        rootRunId: AgentRunTable.rootRunId,
      })
      .from(AgentRunTable)
      .where(eq(AgentRunTable.id, completion.runId))
      .limit(1);
    if (!run) throw new Error("DURABLE_JOB_RUN_INBOX_TARGET_NOT_FOUND");
    await enqueueRunInbox({
      userId: run.userId,
      rootRunId: run.rootRunId,
      targetRunId: completion.runId,
      mode: "inject",
      source: "job",
      content: {
        type: "durable-job-completion",
        correlationId: completion.correlationId,
        jobId: completion.jobId,
        target: completion.target,
        outcome: completion.outcome,
      },
      idempotencyKey: completion.idempotencyKey,
    });
  },
};

// Completion publication is drained from the repository outbox by the worker.
export const durableJobService = createDurableJobService(
  pgDurableJobRepository,
  { injectCompletion: async () => undefined },
);
