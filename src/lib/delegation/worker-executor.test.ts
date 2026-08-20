import type { A2ATaskState, RemoteAgent } from "app-types/remote-agent";
import { createA2AProvider } from "lib/a2a/provider";
import type { AgentRun, RunContinuation } from "lib/ai/runs/types";
import { createRemoteAgentService } from "lib/remote-agent/service";
import {
  decryptRemoteAgentSecret,
  encryptRemoteAgentSecret,
} from "lib/security/secrets";
import { describe, expect, it, vi } from "vitest";
import {
  type DelegationWorkerEvent,
  type DelegationWorkerExecutorDependencies,
  createDelegationWorkerExecutor,
  DelegationWorkerCrash,
} from "./worker-executor";
import {
  H10_CRASH_POINTS,
  formatH10MatrixReport,
  type H10MatrixRow,
} from "./h10-recovery-matrix";

vi.mock("server-only", () => ({}));

const ENCRYPTION_ENV = {
  REMOTE_AGENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

type RemoteState = A2ATaskState | "input-required" | "auth-required";

function fakeA2A(
  states: RemoteState[],
  responseDelayMs = 0,
  statusMessage?: unknown,
) {
  const requests: Array<{
    id: string;
    method: string;
    params: Record<string, unknown>;
    authorization: string | null;
    body: string;
  }> = [];
  let index = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = String(init?.body);
    const request = JSON.parse(body) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    requests.push({
      ...request,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (responseDelayMs)
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
    const requestedState =
      request.method === "tasks/cancel"
        ? "cancelled"
        : states[Math.min(index++, states.length - 1)];
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        id: "remote-task-1",
        contextId: "remote-context-1",
        status: {
          state: requestedState,
          message:
            statusMessage ??
            (requestedState === "completed" ? "Child complete" : undefined),
        },
        artifacts:
          requestedState === "completed"
            ? [{ artifactId: "report-1", parts: [{ text: "result" }] }]
            : [],
      },
    });
  };
  return { fetcher, requests };
}

function remoteService(fetcher: typeof fetch) {
  const remoteAgent: RemoteAgent = {
    id: "remote-1",
    userId: "user-1",
    name: "Fake A2A",
    endpointUrl: "https://fake-a2a.test/rpc",
    status: "active",
    credentialType: null,
    credentialHeader: null,
    encryptedCredential: null,
    agentCard: {
      name: "Fake A2A",
      url: "https://fake-a2a.test/rpc",
      protocolVersion: "0.3.0",
    },
    discoveredAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const repository = {
    listByUserId: async () => [remoteAgent],
    selectById: async (id: string, userId: string) =>
      id === remoteAgent.id && userId === remoteAgent.userId
        ? remoteAgent
        : null,
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  return createRemoteAgentService(
    repository,
    createA2AProvider({
      fetch: fetcher,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  );
}

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "child-1",
    userId: "user-1",
    agentId: null,
    parentRunId: "parent-1",
    rootRunId: "parent-1",
    workspaceId: null,
    taskId: null,
    status: "queued",
    context: { objective: "Research durable delegation" },
    allowedTools: [],
    timeoutMs: 1_000,
    depth: 1,
    tokenBudget: 5_000,
    result: null,
    error: null,
    errorCode: null,
    cancelRequestedAt: null,
    waitingReason: null,
    lastHeartbeatAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    absoluteDeadlineAt: new Date(Date.now() + 1_000),
    attempt: 0,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

class DurableRunFixture {
  readonly runs = new Map<string, AgentRun>([
    [
      "parent-1",
      run({ id: "parent-1", parentRunId: null, status: "running", depth: 0 }),
    ],
    ["child-1", run()],
  ]);
  readonly events: DelegationWorkerEvent[] = [];
  continuation: RunContinuation | null = null;
  encryptedCredential: string | null = null;
  remoteCancellationIntent = false;
  remoteCancellationOutcomes: unknown[] = [];
  submissionId = "submission-stable-1";
  messageId = "message-stable-1";
  remoteTaskId: string | null = null;
  remoteContextId: string | null = null;
  remoteMetadata: Record<string, unknown> | null = null;
  cancellationRequested = false;
  leaseSequence = 0;

  private mutate(id: string, values: Partial<AgentRun>) {
    const current = this.runs.get(id);
    if (!current) return null;
    const updated = { ...current, ...values };
    this.runs.set(id, updated);
    return updated;
  }

  private hasLease(id: string, token: string) {
    const current = this.runs.get(id);
    return Boolean(
      this.ownsLease(id, token) &&
        !current?.cancelRequestedAt &&
        (!current?.absoluteDeadlineAt ||
          current.absoluteDeadlineAt > new Date()),
    );
  }

  private ownsLease(id: string, token: string) {
    const current = this.runs.get(id);
    return Boolean(
      current?.status === "running" &&
        current.leaseToken === token &&
        current.leaseExpiresAt &&
        current.leaseExpiresAt > new Date(),
    );
  }

  claim = async (id: string) => {
    const current = this.runs.get(id);
    if (
      !current ||
      (!["queued", "waiting_external"].includes(current.status) &&
        !(
          current.status === "running" &&
          current.leaseExpiresAt &&
          current.leaseExpiresAt <= new Date()
        ))
    )
      return null;
    const token = `lease-${++this.leaseSequence}`;
    const claimed = this.mutate(id, {
      status: "running",
      leaseToken: token,
      leaseExpiresAt: new Date(Date.now() + 30_000),
      attempt: current.attempt + 1,
      startedAt: current.startedAt ?? new Date(),
    })!;
    return { run: claimed, token };
  };

  heartbeat = async (id: string, token: string) => {
    const current = this.runs.get(id);
    if (
      current?.status !== "running" ||
      current.leaseToken !== token ||
      !current.leaseExpiresAt ||
      current.leaseExpiresAt <= new Date()
    )
      return "lease_lost" as const;
    if (current.cancelRequestedAt || this.cancellationRequested)
      return "cancelled" as const;
    if (current.absoluteDeadlineAt && current.absoluteDeadlineAt <= new Date())
      return "timed_out" as const;
    return "active" as const;
  };

  private finish = async (
    id: string,
    token: string,
    status: "succeeded" | "failed" | "cancelled" | "timed_out",
    values: Partial<AgentRun>,
  ) => {
    if (!this.ownsLease(id, token)) return null;
    const current = this.runs.get(id)!;
    const classifiedStatus = current.cancelRequestedAt
      ? "cancelled"
      : current.absoluteDeadlineAt && current.absoluteDeadlineAt <= new Date()
        ? "timed_out"
        : status;
    this.encryptedCredential = null;
    return this.mutate(id, {
      ...(classifiedStatus === status
        ? values
        : {
            result: null,
            error:
              classifiedStatus === "cancelled"
                ? "Run was cancelled"
                : "Run deadline exceeded",
            errorCode:
              classifiedStatus === "cancelled" ? "CANCELLED" : "TIMED_OUT",
          }),
      status: classifiedStatus,
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    });
  };

  dependencies(remote: ReturnType<typeof remoteService>) {
    const runs: DelegationWorkerExecutorDependencies["runs"] = {
      claim: this.claim,
      heartbeat: this.heartbeat,
      waitForInput: async (id, token) =>
        this.hasLease(id, token)
          ? this.mutate(id, {
              status: "waiting_input",
              waitingReason: "REMOTE_INPUT_REQUIRED",
              leaseToken: null,
              leaseExpiresAt: null,
            })
          : null,
      waitForApproval: async (id, token) =>
        this.hasLease(id, token)
          ? this.mutate(id, {
              status: "waiting_approval",
              waitingReason: "REMOTE_AUTH_REQUIRED",
              leaseToken: null,
              leaseExpiresAt: null,
            })
          : null,
      deferRemoteTask: async (id, token, task) => {
        if (!this.hasLease(id, token)) return null;
        this.remoteTaskId = task.id;
        this.remoteContextId = task.contextId ?? null;
        this.remoteMetadata = task.metadata ?? null;
        return this.mutate(id, {
          status: "waiting_external",
          waitingReason: "REMOTE_WORKING",
          leaseToken: null,
          leaseExpiresAt: null,
        });
      },
      consumeContinuation: async (id, token) =>
        this.hasLease(id, token) ? this.continuation : null,
      consumeContinuationMessage: async (id, token, submissionId) => {
        if (
          !this.hasLease(id, token) ||
          this.continuation?.submissionId !== submissionId
        )
          return false;
        this.continuation = null;
        return true;
      },
      selectTransientCredential: async (id, token) =>
        this.hasLease(id, token) ? this.encryptedCredential : null,
      prepareRemoteSubmission: async (id, token) =>
        this.hasLease(id, token)
          ? {
              submissionId: this.submissionId,
              messageId: this.messageId,
              payload: {
                message: {
                  role: "user",
                  messageId: this.messageId,
                  parts: [
                    { kind: "text", text: "Research durable delegation" },
                  ],
                },
                metadata: { runId: id, submissionId: this.submissionId },
              },
              remoteTaskId: this.remoteTaskId,
              remoteContextId: this.remoteContextId,
            }
          : null,
      recordRemoteTask: async (id, token, task) => {
        if (!this.hasLease(id, token)) return false;
        this.remoteTaskId = task.id;
        this.remoteContextId = task.contextId ?? null;
        this.remoteMetadata = task.metadata ?? null;
        return true;
      },
      succeedWithLease: (id, token, result) =>
        this.finish(id, token, "succeeded", { result }),
      failWithLease: (id, token, error, errorCode) =>
        this.finish(id, token, "failed", {
          error,
          errorCode: errorCode ?? null,
        }),
      cancelWithLease: (id, token, error, errorCode) =>
        this.finish(id, token, "cancelled", {
          error: error ?? null,
          errorCode: errorCode ?? null,
        }),
      timeOutWithLease: (id, token, error, errorCode) =>
        this.finish(id, token, "timed_out", {
          error: error ?? null,
          errorCode: errorCode ?? null,
        }),
      cancelQueued: async (id, details) => {
        if (
          !["queued", "waiting_external"].includes(
            this.runs.get(id)?.status ?? "",
          )
        )
          return null;
        return this.mutate(id, {
          status: "cancelled",
          error: details?.error ?? null,
          errorCode: details?.errorCode ?? null,
          completedAt: new Date(),
        });
      },
      isCancellationRequested: async () => this.cancellationRequested,
      prepareRemoteCancellation: async (id) =>
        id === "child-1" && this.remoteCancellationIntent && this.remoteTaskId
          ? {
              userId: "user-1",
              remoteAgentId: "remote-1",
              remoteTaskId: this.remoteTaskId,
              encryptedCredential: this.encryptedCredential,
            }
          : null,
      recordRemoteCancellation: async (id, outcome) => {
        this.remoteCancellationOutcomes.push(outcome);
        if (!outcome.ok || outcome.task.state !== "cancelled") return null;
        this.remoteCancellationIntent = false;
        this.encryptedCredential = null;
        return this.mutate(id, {
          status: "cancelled",
          completedAt: new Date(),
          errorCode: "CANCELLED",
        });
      },
    };
    return {
      runs,
      selectRun: async (id: string) => this.runs.get(id) ?? null,
      selectDelegation: async () => ({
        targetKind: "remote_agent" as const,
        remoteAgentId: "remote-1",
      }),
      remote,
      executeLocal: vi.fn(),
      enqueue: vi.fn().mockResolvedValue(true),
      markDispatched: vi.fn(),
      decryptCredential: (value: string) =>
        decryptRemoteAgentSecret(value, ENCRYPTION_ENV),
      ingestRemoteArtifacts: vi.fn(async (_claimed, owner) => [
        {
          artifactId: "00000000-0000-4000-8000-000000000001",
          storageKey: "remote/result.txt",
          filename: "result.txt",
          mediaType: "text/plain",
          size: 6,
          sha256: "a".repeat(64),
          owner,
        } as never,
      ]),
      recordEvent: async (event: DelegationWorkerEvent) => {
        this.events.push(event);
      },
      pollMs: 2,
    } satisfies DelegationWorkerExecutorDependencies;
  }

  resume(continuation: RunContinuation) {
    this.continuation = continuation;
    if (continuation.kind === "credential")
      this.encryptedCredential = continuation.encryptedCredential;
    this.mutate("child-1", { status: "queued", waitingReason: null });
  }

  requestRemoteCancellation() {
    this.remoteCancellationIntent = true;
    this.mutate("child-1", { cancelRequestedAt: new Date() });
  }

  expireLease() {
    this.mutate("child-1", { leaseExpiresAt: new Date(0) });
  }

  async parentAwaitsChild() {
    const child = this.runs.get("child-1")!;
    if (child.status !== "succeeded") throw new Error("Child did not succeed");
    return { parentRunId: "parent-1", childResult: child.result };
  }
}

describe("durable delegation worker with fake A2A", () => {
  it("covers the H10 worker crash/recovery matrix", async () => {
    const rows: H10MatrixRow[] = [];

    for (const point of H10_CRASH_POINTS) {
      const fake = fakeA2A(
        point === "during_polling"
          ? ["working", "completed"]
          : point === "after_waiting_persistence"
            ? ["working", "completed"]
            : ["completed"],
      );
      const fixture = new DurableRunFixture();
      const dependencies: DelegationWorkerExecutorDependencies =
        fixture.dependencies(remoteService(fake.fetcher));
      const artifactWrites = vi.spyOn(dependencies, "ingestRemoteArtifacts");
      dependencies.crashAt = point;

      if (point === "during_polling") {
        await createDelegationWorkerExecutor(dependencies)("child-1");
        dependencies.crashAt = point;
        fixture.expireLease();
        await expect(
          createDelegationWorkerExecutor(dependencies)("child-1"),
        ).rejects.toBeInstanceOf(DelegationWorkerCrash);
      } else {
        let crashed = false;
        try {
          await createDelegationWorkerExecutor(dependencies)("child-1");
        } catch (error) {
          crashed = error instanceof DelegationWorkerCrash;
        }
        expect(crashed, `H10 crash point was not reached: ${point}`).toBe(true);
      }

      fixture.expireLease();
      dependencies.crashAt = undefined;
      await createDelegationWorkerExecutor(dependencies)("child-1");
      if (fixture.runs.get("child-1")?.status === "waiting_external") {
        await createDelegationWorkerExecutor(dependencies)("child-1");
      }

      const terminalEvents = fixture.events.filter(
        (event) => event.kind === "terminal",
      );
      const staleToken = "lease-1";
      await expect(
        dependencies.runs.succeedWithLease("child-1", staleToken, {
          stale: true,
        }),
      ).resolves.toBeNull();
      rows.push({
        point,
        recovered: fixture.runs.get("child-1")?.status === "succeeded",
        remoteSubmissions: new Set(
          fake.requests
            .filter((request) => request.method === "message/send")
            .map((request) => request.id),
        ).size,
        artifactWrites: new Set(
          artifactWrites.mock.calls.flatMap((call) =>
            (call[0] as Array<{ artifactId?: string }>).map(
              (artifact) => artifact.artifactId ?? "unknown",
            ),
          ),
        ).size,
        terminalEvents: terminalEvents.length,
        credentialClean: fixture.encryptedCredential === null,
        trajectoryCoherent:
          terminalEvents.length === 1 &&
          fixture.runs.get("child-1")?.status === "succeeded",
      });
    }

    expect(rows).toHaveLength(H10_CRASH_POINTS.length);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recovered: true,
          remoteSubmissions: 1,
          terminalEvents: 1,
          credentialClean: true,
          trajectoryCoherent: true,
        }),
      ]),
    );
    expect(rows.every((row) => row.recovered)).toBe(true);
    expect(rows.every((row) => row.remoteSubmissions === 1)).toBe(true);
    expect(rows.every((row) => row.artifactWrites <= 1)).toBe(true);
    expect(formatH10MatrixReport(rows)).toContain(
      "after_artifact_persist_before_verification",
    );
  });

  it("uses a deterministic initial submission id across crash/reclaim and rejects the old lease", async () => {
    const fake = fakeA2A(["completed"]);
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(remoteService(fake.fetcher));

    const crashed = await fixture.claim("child-1");
    expect(crashed).not.toBeNull();
    const intent = await dependencies.runs.prepareRemoteSubmission(
      "child-1",
      crashed!.token,
    );
    await dependencies.remote.sendTask("user-1", "remote-1", intent!.payload, {
      requestId: intent!.submissionId,
    });
    fixture.expireLease();

    await createDelegationWorkerExecutor(dependencies)("child-1");

    expect(fake.requests.map((request) => request.id)).toEqual([
      "submission-stable-1",
      "submission-stable-1",
    ]);
    await expect(
      dependencies.runs.failWithLease(
        "child-1",
        crashed!.token,
        "late crash result",
        "OLD_WORKER",
      ),
    ).resolves.toBeNull();
    expect(fixture.runs.get("child-1")).toMatchObject({
      status: "succeeded",
      attempt: 2,
    });
  });

  it("continues an input-required task and makes its completed artifacts available to the parent", async () => {
    const fake = fakeA2A(["input-required", "completed"]);
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(remoteService(fake.fetcher));
    const execute = createDelegationWorkerExecutor(dependencies);

    await execute("child-1");
    expect(fixture.runs.get("child-1")).toMatchObject({
      status: "waiting_input",
      waitingReason: "REMOTE_INPUT_REQUIRED",
    });
    expect(fixture.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remote",
          eventType: "agent.input_required",
          toStatus: "input_required",
        }),
      ]),
    );
    fixture.resume({
      kind: "input",
      submissionId: "input-submission-1",
      messageId: "input-message-1",
      payload: { message: "Use the quarterly data" },
    });
    await execute("child-1");

    expect(fake.requests[1]).toMatchObject({
      id: "input-submission-1",
      method: "message/send",
      params: {
        id: "remote-task-1",
        contextId: "remote-context-1",
      },
    });
    expect(JSON.stringify(fake.requests[1].params)).toContain(
      "Use the quarterly data",
    );
    await expect(fixture.parentAwaitsChild()).resolves.toMatchObject({
      parentRunId: "parent-1",
      childResult: {
        artifacts: [
          expect.objectContaining({
            artifactId: "00000000-0000-4000-8000-000000000001",
          }),
        ],
        statusMessage: "Child complete",
      },
    });
    expect(
      fixture.events.some(
        (event) =>
          event.kind === "remote" &&
          event.eventType === "agent.remote_artifact_received",
      ),
    ).toBe(true);
    expect(
      fixture.events.some(
        (event) =>
          event.kind === "remote" &&
          event.eventType === "agent.remote_artifact_verified",
      ),
    ).toBe(true);
    expect(dependencies.ingestRemoteArtifacts).toHaveBeenCalledWith(
      expect.any(Array),
      { userId: "user-1", runId: "child-1" },
    );
  });

  it("fails a child with VERIFICATION_FAILED when claimed artifacts cannot be verified", async () => {
    const fake = fakeA2A(["completed"]);
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(remoteService(fake.fetcher));
    dependencies.ingestRemoteArtifacts = vi.fn(async () => {
      throw new Error("REMOTE_ARTIFACT_MALFORMED");
    });

    await createDelegationWorkerExecutor(dependencies)("child-1");

    expect(fixture.runs.get("child-1")).toMatchObject({
      status: "failed",
      errorCode: "VERIFICATION_FAILED",
      error: "REMOTE_ARTIFACT_MALFORMED",
    });
    expect(
      fixture.events.some(
        (event) =>
          event.kind === "remote" &&
          event.eventType === "agent.remote_artifact_verified",
      ),
    ).toBe(false);
  });

  it("allows an analysis-only completed task with no artifact claims", async () => {
    const fake = fakeA2A(["completed"]);
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(remoteService(fake.fetcher));
    fake.fetcher = async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          id: "remote-task-1",
          status: { state: "completed", message: "Analysis complete" },
        },
      });
    };
    dependencies.remote = remoteService(fake.fetcher);

    await createDelegationWorkerExecutor(dependencies)("child-1");

    expect(fixture.runs.get("child-1")).toMatchObject({
      status: "succeeded",
      result: { artifacts: [], statusMessage: "Analysis complete" },
    });
    expect(dependencies.ingestRemoteArtifacts).not.toHaveBeenCalled();
  });

  it("continues auth with the credential only in the header and redacts it from A2A payloads and results", async () => {
    const secret = "credential-secret-value";
    const fake = fakeA2A(["auth-required", "completed"]);
    const fixture = new DurableRunFixture();
    const execute = createDelegationWorkerExecutor(
      fixture.dependencies(remoteService(fake.fetcher)),
    );

    await execute("child-1");
    expect(fixture.runs.get("child-1")?.status).toBe("waiting_approval");
    expect(fixture.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remote",
          eventType: "agent.auth_required",
          toStatus: "auth_required",
        }),
      ]),
    );
    fixture.resume({
      kind: "credential",
      submissionId: "auth-submission-1",
      messageId: "auth-message-1",
      encryptedCredential: encryptRemoteAgentSecret(
        JSON.stringify({ type: "bearer", value: secret }),
        ENCRYPTION_ENV,
      ),
    });
    await execute("child-1");

    expect(fake.requests[1].authorization).toBe(`Bearer ${secret}`);
    expect(fake.requests[1].body).not.toContain(secret);
    expect(JSON.stringify(fixture.runs.get("child-1")?.result)).not.toContain(
      secret,
    );
    expect(JSON.stringify(fixture.events)).not.toContain(secret);
  });

  it("persists waiting_external, releases the lease, and enqueues a delayed recheck", async () => {
    const fake = fakeA2A(["working", "completed"]);
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(remoteService(fake.fetcher));
    const execute = createDelegationWorkerExecutor(dependencies);

    await execute("child-1");

    expect(fixture.runs.get("child-1")).toMatchObject({
      status: "waiting_external",
      waitingReason: "REMOTE_WORKING",
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(dependencies.enqueue).toHaveBeenCalledWith("child-1", 1);
    expect(dependencies.markDispatched).toHaveBeenCalledWith("child-1");
    expect(fake.requests).toHaveLength(1);

    await execute("child-1");
    expect(fake.requests[1].method).toBe("tasks/get");
    expect(fixture.runs.get("child-1")?.status).toBe("succeeded");
  });

  it("keeps durable deferred polling recoverable when direct enqueue fails", async () => {
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(
      remoteService(fakeA2A(["working"]).fetcher),
    );
    dependencies.enqueue = vi.fn().mockRejectedValue(new Error("queue down"));

    await createDelegationWorkerExecutor(dependencies)("child-1");

    expect(fixture.runs.get("child-1")).toMatchObject({
      status: "waiting_external",
      leaseToken: null,
    });
    expect(fixture.remoteTaskId).toBe("remote-task-1");
    expect(dependencies.markDispatched).not.toHaveBeenCalled();
  });

  it("retains a transient credential through deferred polls and removes it at terminal", async () => {
    const secret = "poll-credential";
    const fake = fakeA2A(["auth-required", "working", "completed"]);
    const fixture = new DurableRunFixture();
    const execute = createDelegationWorkerExecutor(
      fixture.dependencies(remoteService(fake.fetcher)),
    );

    await execute("child-1");
    fixture.resume({
      kind: "credential",
      submissionId: "auth-submission-1",
      messageId: "auth-message-1",
      encryptedCredential: encryptRemoteAgentSecret(
        JSON.stringify({ type: "bearer", value: secret }),
        ENCRYPTION_ENV,
      ),
    });
    await execute("child-1");
    expect(fixture.encryptedCredential).not.toBeNull();

    await execute("child-1");

    expect(fake.requests[1].authorization).toBe(`Bearer ${secret}`);
    expect(fake.requests[2].authorization).toBe(`Bearer ${secret}`);
    expect(fixture.runs.get("child-1")?.status).toBe("succeeded");
    expect(fixture.encryptedCredential).toBeNull();
  });

  it("retries and reconciles cancellation of a waiting remote task with its credential", async () => {
    const secret = "cancel-credential";
    const fake = fakeA2A(["working"]);
    let cancelAttempts = 0;
    const baseFetcher = fake.fetcher;
    const fetcher: typeof fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === "tasks/cancel" && cancelAttempts++ === 0)
        throw new Error("temporary cancel failure");
      return baseFetcher(url, init);
    };
    const fixture = new DurableRunFixture();
    fixture.encryptedCredential = encryptRemoteAgentSecret(
      JSON.stringify({ type: "bearer", value: secret }),
      ENCRYPTION_ENV,
    );
    const execute = createDelegationWorkerExecutor(
      fixture.dependencies(remoteService(fetcher)),
    );
    await execute("child-1");
    fixture.requestRemoteCancellation();

    await execute.cancelRemote("child-1");
    expect(fixture.runs.get("child-1")?.status).toBe("waiting_external");
    expect(fixture.remoteCancellationOutcomes[0]).toMatchObject({ ok: false });

    await execute.cancelRemote("child-1");
    expect(fixture.runs.get("child-1")?.status).toBe("cancelled");
    expect(fixture.encryptedCredential).toBeNull();
    expect(
      fake.requests.find((request) => request.method === "tasks/cancel")
        ?.authorization,
    ).toBe(`Bearer ${secret}`);
  });

  it("persists bounded sanitized waiting requests from the initial response", async () => {
    const secret = `Bearer ${"a".repeat(40)}`;
    const fake = fakeA2A(
      ["input-required"],
      0,
      `${secret} ${"x".repeat(3_000)}`,
    );
    const fixture = new DurableRunFixture();

    await createDelegationWorkerExecutor(
      fixture.dependencies(remoteService(fake.fetcher)),
    )("child-1");

    expect(JSON.stringify(fixture.remoteMetadata)).not.toContain(secret);
    expect(fixture.remoteMetadata).toMatchObject({
      statusMessage: expect.stringContaining("[REDACTED]"),
      waitingRequest: expect.stringContaining("[REDACTED]"),
    });
    expect(
      String(fixture.remoteMetadata?.statusMessage).length,
    ).toBeLessThanOrEqual(2_000);
  });

  it("does not finish after lease expiry", async () => {
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(
      remoteService(fakeA2A(["completed"]).fetcher),
    );
    const claimed = await fixture.claim("child-1");
    fixture.expireLease();

    await expect(
      dependencies.runs.succeedWithLease("child-1", claimed!.token, {
        late: true,
      }),
    ).resolves.toBeNull();
    expect(fixture.runs.get("child-1")?.status).toBe("running");
  });

  it("gives cancellation precedence over a leased success", async () => {
    const fixture = new DurableRunFixture();
    const dependencies = fixture.dependencies(
      remoteService(fakeA2A(["completed"]).fetcher),
    );
    const claimed = await fixture.claim("child-1");
    fixture.runs.set(
      "child-1",
      run({
        ...fixture.runs.get("child-1"),
        cancelRequestedAt: new Date(),
      }),
    );

    const finished = await dependencies.runs.succeedWithLease(
      "child-1",
      claimed!.token,
      { shouldNotPersist: true },
    );

    expect(finished).toMatchObject({
      status: "cancelled",
      errorCode: "CANCELLED",
      result: null,
    });
  });
});
