import type { DurableJobLease } from "lib/jobs/contracts";
import type { DurableJobPgRepository } from "lib/jobs/repository.pg";
import { DurableJobTargetRegistry } from "lib/jobs/targets";
import { describe, expect, test, vi } from "vitest";
import { createDurableJobWorker } from "./durable-job-worker";

vi.mock("server-only", () => ({}));

function lease(): DurableJobLease {
  const leaseToken = "lease-1";
  return {
    token: leaseToken,
    job: {
      id: "job-1",
      idempotencyKey: "request-1",
      target: { kind: "job", jobType: "capability-orchestration" },
      payload: {},
      status: "running",
      attempt: 1,
      leaseToken,
      leaseExpiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  };
}

function setup() {
  const repository = {
    claim: vi.fn().mockResolvedValueOnce(lease()).mockResolvedValue(null),
    heartbeat: vi.fn(),
    finish: vi.fn(),
    retry: vi.fn(),
    claimCompletionOutbox: vi.fn(),
    completeCompletionOutbox: vi.fn(),
    retryCompletionOutbox: vi.fn(),
  } as unknown as DurableJobPgRepository;
  const runInbox = { injectCompletion: vi.fn() };
  return {
    repository,
    runInbox,
    worker: createDurableJobWorker("worker-1", {
      repository,
      runInbox,
      targets: new DurableJobTargetRegistry(),
    }),
  };
}

describe("durable job worker", () => {
  test("terminalizes unsupported or unregistered targets without retrying", async () => {
    const { repository, worker } = setup();
    await worker.executeOne();
    expect(repository.finish).toHaveBeenCalledWith({
      jobId: "job-1",
      leaseToken: "lease-1",
      outcome: {
        status: "failed",
        error: "DURABLE_JOB_TARGET_NOT_REGISTERED",
        errorCode: "TARGET_REJECTED",
      },
    });
    expect(repository.retry).not.toHaveBeenCalled();
  });

  test("delivers completion outbox before acknowledging its lease", async () => {
    const { repository, runInbox, worker } = setup();
    const outbox = {
      id: "outbox-1",
      leaseToken: "outbox-lease-1",
      completion: {
        idempotencyKey: "durable-job:job-1:terminal",
        runId: "run-1",
        correlationId: "call-1",
        jobId: "job-1",
        target: { kind: "job", jobType: "capability-orchestration" } as const,
        outcome: { status: "completed" as const },
      },
    };
    vi.mocked(repository.claimCompletionOutbox).mockResolvedValue(outbox);
    vi.mocked(repository.completeCompletionOutbox).mockResolvedValue(true);

    await worker.publishOne();

    expect(runInbox.injectCompletion).toHaveBeenCalledWith(outbox.completion);
    expect(repository.completeCompletionOutbox).toHaveBeenCalledWith(outbox);
    expect(runInbox.injectCompletion.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(repository.completeCompletionOutbox).mock
        .invocationCallOrder[0],
    );
  });
});
