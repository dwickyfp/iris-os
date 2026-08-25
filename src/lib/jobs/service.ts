import type {
  CreateDurableJobInput,
  DurableJobMutationResult,
  DurableJobOutcome,
  DurableJobRepository,
  RunInbox,
  TerminalDurableJob,
} from "./contracts";

function requireText(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function requireLeaseDuration(leaseDurationMs: number) {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("leaseDurationMs must be a positive integer");
  }
}

async function injectCompletion(inbox: RunInbox, job: TerminalDurableJob) {
  if (!job.runInbox) return;
  await inbox.injectCompletion({
    idempotencyKey: `durable-job:${job.id}:terminal`,
    runId: job.runInbox.runId,
    correlationId: job.runInbox.correlationId,
    jobId: job.id,
    target: job.target,
    outcome: job.outcome,
  });
}

export function createDurableJobService(
  repository: DurableJobRepository,
  runInbox: RunInbox,
) {
  async function publishTerminal(result: DurableJobMutationResult) {
    if (result.kind === "applied" || result.kind === "replayed") {
      await injectCompletion(runInbox, result.job);
    }
    return result;
  }

  return {
    async create(input: CreateDurableJobInput) {
      requireText(input.id, "id");
      requireText(input.idempotencyKey, "idempotencyKey");
      if (input.runInbox) {
        requireText(input.runInbox.runId, "runInbox.runId");
        requireText(input.runInbox.correlationId, "runInbox.correlationId");
      }
      return repository.create(input);
    },

    claim(workerId: string, leaseDurationMs: number) {
      requireText(workerId, "workerId");
      requireLeaseDuration(leaseDurationMs);
      return repository.claim({ workerId, leaseDurationMs });
    },

    heartbeat(jobId: string, leaseToken: string, leaseDurationMs: number) {
      requireText(jobId, "jobId");
      requireText(leaseToken, "leaseToken");
      requireLeaseDuration(leaseDurationMs);
      return repository.heartbeat({ jobId, leaseToken, leaseDurationMs });
    },

    async finish(
      jobId: string,
      leaseToken: string,
      outcome: DurableJobOutcome,
    ) {
      requireText(jobId, "jobId");
      requireText(leaseToken, "leaseToken");
      return publishTerminal(
        await repository.finish({ jobId, leaseToken, outcome }),
      );
    },

    async cancel(jobId: string, reason?: string) {
      requireText(jobId, "jobId");
      return publishTerminal(await repository.cancel({ jobId, reason }));
    },
  };
}
