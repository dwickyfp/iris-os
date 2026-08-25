import { describe, expect, it, vi } from "vitest";
import type {
  CreateDurableJobInput,
  DurableJob,
  DurableJobOutcome,
  DurableJobRepository,
  RunInbox,
  TerminalDurableJob,
} from "./contracts";
import { createDurableJobService } from "./service";

function memoryRepository() {
  const jobs = new Map<string, DurableJob>();
  const idempotency = new Map<string, string>();
  const finishedTokens = new Map<string, string>();
  let leaseSequence = 0;
  let now = 0;

  const repository: DurableJobRepository = {
    async create(input: CreateDurableJobInput) {
      const existingId = idempotency.get(input.idempotencyKey);
      if (existingId) {
        return { kind: "existing", job: jobs.get(existingId)! };
      }
      const timestamp = new Date(now);
      const job: DurableJob = {
        ...input,
        status: "queued",
        attempt: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      jobs.set(job.id, job);
      idempotency.set(job.idempotencyKey, job.id);
      return { kind: "created", job };
    },

    async claim({ leaseDurationMs }) {
      const job = [...jobs.values()].find(
        (candidate) =>
          candidate.status === "queued" ||
          (candidate.status === "running" &&
            candidate.leaseExpiresAt!.getTime() <= now),
      );
      if (!job) return null;
      const token = `lease-${++leaseSequence}`;
      const claimed = {
        ...job,
        status: "running" as const,
        attempt: job.attempt + 1,
        leaseToken: token,
        leaseExpiresAt: new Date(now + leaseDurationMs),
        updatedAt: new Date(now),
      };
      jobs.set(job.id, claimed);
      return { job: claimed, token };
    },

    async heartbeat({ jobId, leaseToken, leaseDurationMs }) {
      const job = jobs.get(jobId);
      if (!job) return { kind: "not_found" };
      if (
        job.status !== "running" ||
        job.leaseToken !== leaseToken ||
        job.leaseExpiresAt!.getTime() <= now
      ) {
        return { kind: "lease_lost" };
      }
      const active = {
        ...job,
        status: "running" as const,
        leaseToken,
        leaseExpiresAt: new Date(now + leaseDurationMs),
        updatedAt: new Date(now),
      };
      jobs.set(jobId, active);
      return { kind: "active", lease: { job: active, token: leaseToken } };
    },

    async finish({ jobId, leaseToken, outcome }) {
      const job = jobs.get(jobId);
      if (!job) return { kind: "not_found" };
      if (finishedTokens.get(jobId) === leaseToken) {
        return JSON.stringify(job.outcome) === JSON.stringify(outcome)
          ? { kind: "replayed", job: job as TerminalDurableJob }
          : { kind: "conflict" };
      }
      if (
        job.status !== "running" ||
        job.leaseToken !== leaseToken ||
        job.leaseExpiresAt!.getTime() <= now
      ) {
        return { kind: "lease_lost" };
      }
      const terminal: TerminalDurableJob = {
        ...job,
        status: outcome.status,
        outcome,
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date(now),
      };
      jobs.set(jobId, terminal);
      finishedTokens.set(jobId, leaseToken);
      return { kind: "applied", job: terminal };
    },

    async cancel({ jobId, reason }) {
      const job = jobs.get(jobId);
      if (!job) return { kind: "not_found" };
      if (job.status === "cancelled") {
        return { kind: "replayed", job: job as TerminalDurableJob };
      }
      if (job.outcome) return { kind: "conflict" };
      const cancelled: TerminalDurableJob = {
        ...job,
        status: "cancelled",
        outcome: { status: "cancelled", reason },
        leaseToken: undefined,
        leaseExpiresAt: undefined,
        updatedAt: new Date(now),
      };
      jobs.set(jobId, cancelled);
      return { kind: "applied", job: cancelled };
    },
  };

  return {
    repository,
    jobs,
    advance(ms: number) {
      now += ms;
    },
  };
}

function input(overrides: Partial<CreateDurableJobInput> = {}) {
  return {
    id: "job-1",
    idempotencyKey: "request-1",
    target: { kind: "workflow", workflowId: "workflow-1" } as const,
    payload: { topic: "durability" },
    runInbox: { runId: "run-1", correlationId: "tool-call-1" },
    ...overrides,
  };
}

function setup() {
  const store = memoryRepository();
  const injectCompletion = vi.fn<RunInbox["injectCompletion"]>(async () => {});
  const service = createDurableJobService(store.repository, {
    injectCompletion,
  });
  return { ...store, service, injectCompletion };
}

describe("durable job service", () => {
  it("creates idempotently without collapsing execution target kinds", async () => {
    const { service } = setup();
    const created = await service.create(input());
    const duplicate = await service.create(
      input({ id: "job-2", target: { kind: "agent", agentId: "agent-1" } }),
    );

    expect(created.kind).toBe("created");
    expect(duplicate).toEqual({ kind: "existing", job: created.job });
    expect(created.job.target).toEqual({
      kind: "workflow",
      workflowId: "workflow-1",
    });
  });

  it("fences heartbeat and finish after an expired lease is reclaimed", async () => {
    const { advance, service } = setup();
    await service.create(input());
    const first = await service.claim("worker-1", 100);
    advance(101);
    const second = await service.claim("worker-2", 100);

    expect(first?.token).not.toBe(second?.token);
    await expect(
      service.heartbeat("job-1", first!.token, 100),
    ).resolves.toEqual({ kind: "lease_lost" });
    await expect(
      service.finish("job-1", first!.token, {
        status: "completed",
        result: "stale",
      }),
    ).resolves.toEqual({ kind: "lease_lost" });
    await expect(
      service.finish("job-1", second!.token, {
        status: "completed",
        result: "current",
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      job: { status: "completed", attempt: 2 },
    });
  });

  it("replays finish safely and injects one idempotent completion identity", async () => {
    const { injectCompletion, service } = setup();
    await service.create(input());
    const lease = await service.claim("worker-1", 100);
    const outcome: DurableJobOutcome = {
      status: "failed",
      error: "provider unavailable",
      errorCode: "UPSTREAM_UNAVAILABLE",
    };

    await expect(
      service.finish("job-1", lease!.token, outcome),
    ).resolves.toMatchObject({ kind: "applied" });
    await expect(
      service.finish("job-1", lease!.token, outcome),
    ).resolves.toMatchObject({ kind: "replayed" });

    expect(injectCompletion).toHaveBeenCalledTimes(2);
    expect(injectCompletion.mock.calls[0][0]).toEqual(
      injectCompletion.mock.calls[1][0],
    );
    expect(injectCompletion).toHaveBeenCalledWith({
      idempotencyKey: "durable-job:job-1:terminal",
      runId: "run-1",
      correlationId: "tool-call-1",
      jobId: "job-1",
      target: { kind: "workflow", workflowId: "workflow-1" },
      outcome,
    });
  });

  it("cancels queued or running jobs, invalidates leases, and notifies runs", async () => {
    const { injectCompletion, service } = setup();
    await service.create(input());
    const lease = await service.claim("worker-1", 100);

    await expect(
      service.cancel("job-1", "user request"),
    ).resolves.toMatchObject({ kind: "applied", job: { status: "cancelled" } });
    await expect(
      service.finish("job-1", lease!.token, { status: "completed" }),
    ).resolves.toEqual({ kind: "lease_lost" });
    expect(injectCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: { status: "cancelled", reason: "user request" },
      }),
    );
  });

  it("rejects invalid lease and idempotency inputs before repository calls", async () => {
    const { repository } = memoryRepository();
    const create = vi.spyOn(repository, "create");
    const claim = vi.spyOn(repository, "claim");
    const service = createDurableJobService(repository, {
      injectCompletion: vi.fn(async () => {}),
    });

    await expect(
      service.create(input({ idempotencyKey: " " })),
    ).rejects.toThrow("idempotencyKey");
    expect(() => service.claim("worker-1", 0)).toThrow("leaseDurationMs");
    expect(create).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });
});
