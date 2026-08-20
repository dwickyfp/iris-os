import { describe, expect, it, vi } from "vitest";
import type {
  SandboxEventSink,
  SandboxInstance,
  SandboxProfile,
  SandboxProvider,
  SandboxRepository,
  SandboxSessionRecord,
} from "./contracts";
import { SandboxManager } from "./manager";

const profile: SandboxProfile = {
  id: "python",
  cpuMillis: 1_000,
  memoryMb: 512,
  diskMb: 1_024,
  executionTimeoutMs: 1_000,
  idleTimeoutMs: 5_000,
  network: "none",
};

function setup() {
  const sessions: SandboxSessionRecord[] = [];
  const executions = new Map<string, any>();
  const repository: SandboxRepository = {
    claimSession: vi.fn(async (session) => {
      const existing = sessions.find(
        (current) =>
          current.runId === session.runId &&
          current.provider === session.provider,
      );
      if (existing) return { session: existing, claimed: false };
      sessions.push(session);
      return { session, claimed: true };
    }),
    activateSession: vi.fn(async (id, _creatorToken, providerInstanceId) => {
      const session = sessions.find((session) => session.id === id)!;
      if (session.status !== "creating") return false;
      Object.assign(session, {
        status: "active",
        providerInstanceId,
      });
      return true;
    }),
    failSessionCreation: vi.fn(async (id) => {
      const session = sessions.find((session) => session.id === id)!;
      if (session.status === "creating") session.status = "failed";
    }),
    cancelSessionsByRun: vi.fn(async (runId, provider) => {
      const found = sessions.filter(
        (session) =>
          session.runId === runId &&
          session.provider === provider &&
          ["creating", "active", "destroying"].includes(session.status),
      );
      for (const session of found) session.status = "cancelled";
      return found;
    }),
    cancelSessionsByRootRun: vi.fn(async (_rootRunId, provider) => {
      const found = sessions.filter(
        (session) =>
          session.provider === provider &&
          ["creating", "active", "destroying"].includes(session.status),
      );
      for (const session of found) session.status = "cancelled";
      return found;
    }),
    touchSession: vi.fn(async () => undefined),
    finishSession: vi.fn(async (id, status) => {
      Object.assign(sessions.find((session) => session.id === id)!, { status });
    }),
    listExpiredSessions: vi.fn(async () => []),
    reserveExecution: vi.fn(async (execution) => {
      executions.set(execution.id, execution);
      return true;
    }),
    startExecution: vi.fn(async (id, reservationToken, startedAt) => {
      const execution = executions.get(id);
      if (
        execution.status !== "reserved" ||
        execution.reservationToken !== reservationToken
      )
        return false;
      Object.assign(execution, { status: "running", startedAt });
      return true;
    }),
    releaseExecution: vi.fn(async (id, reservationToken, values) => {
      const execution = executions.get(id);
      if (
        execution.status !== "reserved" ||
        execution.reservationToken !== reservationToken
      )
        return false;
      Object.assign(execution, values);
      return true;
    }),
    settleExecution: vi.fn(
      async (id, reservationToken, durationMs, observedWallDurationMs) => {
        const execution = executions.get(id);
        if (
          execution.reservationToken !== reservationToken ||
          execution.chargedAt
        )
          return false;
        Object.assign(execution, {
          durationMs,
          observedWallDurationMs,
          chargedAt: new Date(),
        });
        return true;
      },
    ),
    finishExecution: vi.fn(async (id, values) => {
      const execution = executions.get(id);
      if (execution.status !== "running") return false;
      Object.assign(execution, values);
      return true;
    }),
    cancelRunningExecutions: vi.fn(async () => undefined),
  };
  const instance: SandboxInstance = {
    id: "runner-1",
    profile,
    executePython: vi.fn(async () => ({
      executionId: "provider-execution",
      exitCode: 0,
      stdout: "3\n",
      stderr: "",
      durationMs: 120,
      files: [],
    })),
    cancel: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
  const provider: SandboxProvider = {
    name: "fake",
    status: vi.fn(async () => ({
      ready: true,
      provider: "fake",
      checkedAt: new Date(),
    })),
    create: vi.fn(async () => instance),
    connect: vi.fn(async () => instance),
  };
  const policy = { authorize: vi.fn(async () => undefined) };
  const events: SandboxEventSink = {
    record: vi.fn(async () => undefined),
  };
  const artifacts = {
    capture: vi.fn(async (): Promise<unknown[]> => []),
    discard: vi.fn(async () => undefined),
  };
  const manager = new SandboxManager({
    provider,
    repository,
    policy,
    events,
    artifacts,
    generateId: (() => {
      let id = 0;
      return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
    })(),
  });
  return {
    manager,
    provider,
    repository,
    instance,
    sessions,
    executions,
    events,
    artifacts,
    policy,
  };
}

describe("SandboxManager", () => {
  it("reuses one sandbox session for executions in the same run", async () => {
    const { manager, provider, instance, executions, repository } = setup();
    const scope = { runId: "run-1", userId: "user-1" };

    await manager.executePython({
      scope,
      profile,
      request: { code: "1 + 2" },
      maxComputeMs: 2_000,
    });
    await manager.executePython({
      scope,
      profile,
      request: { code: "2 + 3" },
      maxComputeMs: 2_000,
    });

    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(instance.executePython).toHaveBeenCalledTimes(2);
    expect(executions.size).toBe(2);
    expect(repository.settleExecution).toHaveBeenCalledTimes(2);
  });

  it("persists cancellation when the caller aborts execution", async () => {
    const { manager, instance, repository, events } = setup();
    const controller = new AbortController();
    vi.mocked(instance.executePython).mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await expect(
      manager.executePython({
        scope: { runId: "run-1", userId: "user-1" },
        profile,
        request: { code: "while True: pass" },
        maxComputeMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");

    expect(repository.finishExecution).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "cancelled", errorCode: "CANCELLED" }),
    );
    expect(events.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox.execution_cancelled" }),
    );
  });

  it("destroys the active run-scoped session on run cancellation", async () => {
    const { manager, instance, repository } = setup();
    const scope = { runId: "run-cancel", userId: "user-1" };
    await manager.executePython({
      scope,
      profile,
      request: { code: "print('started')" },
      maxComputeMs: 1_000,
    });

    await expect(manager.cancelByRun(scope.runId)).resolves.toBe(true);
    expect(instance.destroy).toHaveBeenCalledOnce();
    expect(repository.cancelSessionsByRun).toHaveBeenCalledWith(
      scope.runId,
      "fake",
      expect.any(Date),
    );
  });

  it("lets independent managers attach to one concurrently created session", async () => {
    const setupResult = setup();
    let releaseCreate!: () => void;
    const createBlocked = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    vi.mocked(setupResult.provider.create).mockImplementationOnce(async () => {
      await createBlocked;
      return setupResult.instance;
    });
    const otherManager = new SandboxManager({
      provider: setupResult.provider,
      repository: setupResult.repository,
      policy: setupResult.policy,
      events: setupResult.events,
      artifacts: setupResult.artifacts,
    });
    const input = {
      scope: { runId: "run-distributed", userId: "user-1" },
      profile,
      request: { code: "print('once')" },
    };

    const first = setupResult.manager.executePython({
      ...input,
      maxComputeMs: 1_000,
    });
    await vi.waitFor(() =>
      expect(setupResult.provider.create).toHaveBeenCalledOnce(),
    );
    const second = otherManager.executePython({
      ...input,
      maxComputeMs: 1_000,
    });
    releaseCreate();
    await Promise.all([first, second]);

    expect(setupResult.provider.create).toHaveBeenCalledOnce();
    expect(setupResult.provider.connect).toHaveBeenCalledOnce();
  });

  it("persists cancellation during creation and destroys the late instance", async () => {
    const { manager, provider, instance, sessions } = setup();
    let releaseCreate!: () => void;
    vi.mocked(provider.create).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCreate = () => resolve(instance);
        }),
    );
    const execution = manager.executePython({
      scope: { runId: "run-create-cancel", userId: "user-1" },
      profile,
      request: { code: "print('too late')" },
      maxComputeMs: 1_000,
    });
    await vi.waitFor(() => expect(provider.create).toHaveBeenCalledOnce());

    await expect(manager.cancelByRun("run-create-cancel")).resolves.toBe(true);
    releaseCreate();

    await expect(execution).rejects.toThrow("RUN_CANCELLED");
    expect(instance.destroy).toHaveBeenCalledOnce();
    expect(sessions[0]).toMatchObject({
      status: "cancelled",
    });
  });

  it("does not create a provider session after cancellation", async () => {
    const { manager, repository, provider, instance } = setup();
    vi.mocked(repository.claimSession).mockImplementationOnce(
      async (session) => ({
        session: {
          ...session,
          status: "cancelled",
          errorCode: "RUN_CANCELLED",
        },
        claimed: false,
      }),
    );

    await expect(
      manager.executePython({
        scope: { runId: "run-cancelled-first", userId: "user-1" },
        profile,
        request: { code: "print('never')" },
        maxComputeMs: 1_000,
      }),
    ).rejects.toThrow("RUN_CANCELLED");

    expect(provider.status).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(instance.executePython).not.toHaveBeenCalled();
  });

  it("does not call the provider when the reservation fence loses", async () => {
    const { manager, repository, instance } = setup();
    vi.mocked(repository.reserveExecution).mockResolvedValueOnce(false);

    await expect(
      manager.executePython({
        scope: { runId: "run-cancelled-before-reserve", userId: "user-1" },
        profile,
        request: { code: "print('never')" },
        maxComputeMs: 1_000,
      }),
    ).rejects.toThrow("RUN_CANCELLED");

    expect(instance.executePython).not.toHaveBeenCalled();
    expect(repository.startExecution).not.toHaveBeenCalled();
    expect(repository.releaseExecution).not.toHaveBeenCalled();
  });

  it("does not call the provider when the start fence loses", async () => {
    const { manager, repository, instance } = setup();
    vi.mocked(repository.startExecution).mockResolvedValueOnce(false);

    await expect(
      manager.executePython({
        scope: { runId: "run-cancelled-before-start", userId: "user-1" },
        profile,
        request: { code: "print('never')" },
        maxComputeMs: 1_000,
      }),
    ).rejects.toThrow("RUN_CANCELLED");

    expect(instance.executePython).not.toHaveBeenCalled();
    expect(repository.releaseExecution).toHaveBeenCalledOnce();
  });

  it("never extends a reused session beyond its absolute lifetime", async () => {
    const { manager, sessions } = setup();
    const boundedProfile = {
      ...profile,
      idleTimeoutMs: 5_000,
      absoluteTimeoutMs: 2_000,
    };
    await manager.executePython({
      scope: { runId: "run-ttl", userId: "user-1" },
      profile: boundedProfile,
      request: { code: "print('ok')" },
      maxComputeMs: 1_000,
    });
    expect(sessions[0].expiresAt.getTime()).toBeLessThanOrEqual(
      sessions[0].createdAt.getTime() + 2_000,
    );
  });

  it("persists runner timeouts distinctly from generic failures", async () => {
    const { manager, instance, repository } = setup();
    vi.mocked(instance.executePython).mockRejectedValueOnce(
      new Error("IRIS_RUNNER_HTTP_408"),
    );
    await expect(
      manager.executePython({
        scope: { runId: "run-timeout", userId: "user-1" },
        profile,
        request: { code: "while True: pass" },
        maxComputeMs: 1_000,
      }),
    ).rejects.toThrow("IRIS_RUNNER_HTTP_408");
    expect(repository.finishExecution).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "timed_out",
        errorCode: "SANDBOX_TIMED_OUT",
      }),
    );
  });

  it.each([
    {
      name: "provider unavailable",
      fail(setupResult: ReturnType<typeof setup>) {
        vi.mocked(setupResult.provider.status).mockResolvedValueOnce({
          ready: false,
          provider: "fake",
          reason: "SANDBOX_PROVIDER_UNAVAILABLE",
          checkedAt: new Date(),
        });
      },
    },
    {
      name: "session persistence failure",
      fail(setupResult: ReturnType<typeof setup>) {
        vi.mocked(setupResult.repository.claimSession).mockRejectedValueOnce(
          new Error("session db failed"),
        );
      },
    },
    {
      name: "provider session creation failure",
      fail(setupResult: ReturnType<typeof setup>) {
        vi.mocked(setupResult.provider.create).mockRejectedValueOnce(
          new Error("provider create failed"),
        );
      },
    },
    {
      name: "execution persistence failure",
      fail(setupResult: ReturnType<typeof setup>) {
        vi.mocked(setupResult.repository.reserveExecution).mockRejectedValueOnce(
          new Error("execution db failed"),
        );
      },
    },
    {
      name: "execution start event failure",
      fail(setupResult: ReturnType<typeof setup>) {
        vi.mocked(setupResult.events.record)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("event failed"));
      },
    },
  ])(
    "releases reserved compute on $name before process execution",
    async ({ fail }) => {
      const setupResult = setup();
      fail(setupResult);

      await expect(
        setupResult.manager.executePython({
          scope: { runId: "run-pre-exec", userId: "user-1" },
          profile,
          request: { code: "print('never runs')" },
          maxComputeMs: 1_000,
        }),
      ).rejects.toThrow();

      expect(setupResult.instance.executePython).not.toHaveBeenCalled();
      if (setupResult.executions.size > 0)
        expect(setupResult.repository.releaseExecution).toHaveBeenCalledOnce();
    },
  );

  it("persists artifact capture failure without succeeding or double committing", async () => {
    const { manager, repository, artifacts, events } = setup();
    const captureError = new Error("artifact repository failed");
    artifacts.capture.mockRejectedValueOnce(captureError);

    let thrown: unknown;
    try {
      await manager.executePython({
        scope: { runId: "run-artifact", userId: "user-1" },
        profile,
        request: { code: "print('ok')" },
        maxComputeMs: 1_000,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(captureError);
    expect(repository.finishExecution).toHaveBeenCalledTimes(1);
    expect(repository.finishExecution).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        errorCode: "SANDBOX_ARTIFACT_CAPTURE_FAILED",
      }),
    );
    expect(events.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox.execution_completed" }),
    );
    expect(repository.settleExecution).toHaveBeenCalledOnce();
  });

  it("caps chargeable duration by reservation and preserves observed wall time", async () => {
    const { manager, instance, repository } = setup();
    vi.mocked(instance.executePython).mockResolvedValueOnce({
      executionId: "provider-execution",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 2_500,
      files: [],
    });

    await manager.executePython({
      scope: { runId: "run-capped", userId: "user-1" },
      profile,
      request: { code: "print('ok')" },
      maxComputeMs: 1_000,
    });

    expect(repository.finishExecution).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        durationMs: 1_000,
        observedWallDurationMs: 2_500,
      }),
    );
    expect(repository.settleExecution).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      1_000,
      2_500,
      expect.any(Date),
    );
  });

  it("captures artifacts before persisting process success", async () => {
    const { manager, repository, artifacts } = setup();
    const order: string[] = [];
    artifacts.capture.mockImplementationOnce(async () => {
      order.push("capture");
      return [];
    });
    vi.mocked(repository.finishExecution).mockImplementationOnce(async () => {
      order.push("finish");
      return true;
    });

    await manager.executePython({
      scope: { runId: "run-order", userId: "user-1" },
      profile,
      request: { code: "print('ok')" },
      maxComputeMs: 1_000,
    });

    expect(order).toEqual(["capture", "finish"]);
  });

  it("discards captured artifacts when success persistence fails", async () => {
    const { manager, repository, artifacts } = setup();
    const captured = [{ artifactId: "artifact-1" }];
    artifacts.capture.mockResolvedValueOnce(captured);
    vi.mocked(repository.finishExecution).mockRejectedValueOnce(
      new Error("finish db failed"),
    );

    await expect(
      manager.executePython({
        scope: { runId: "run-finish-db", userId: "user-1" },
        profile,
        request: { code: "print('ok')" },
        maxComputeMs: 1_000,
      }),
    ).rejects.toThrow("finish db failed");

    expect(artifacts.discard).toHaveBeenCalledWith(captured);
  });

  it("waits for durable artifact rollback when success persistence fails", async () => {
    const { manager, repository, artifacts } = setup();
    const rollbackError = new Error("cleanup enqueue failed");
    artifacts.capture.mockResolvedValueOnce([{ artifactId: "artifact-1" }]);
    vi.mocked(repository.finishExecution).mockRejectedValueOnce(
      new Error("finish db failed"),
    );
    artifacts.discard.mockRejectedValueOnce(rollbackError);

    await expect(
      manager.executePython({
        scope: { runId: "run-cleanup-fail", userId: "user-1" },
        profile,
        request: { code: "print('ok')" },
        maxComputeMs: 1_000,
      }),
    ).rejects.toBe(rollbackError);
  });

  it.each([
    {
      name: "pre-execution failure",
      arrange(result: ReturnType<typeof setup>) {
        vi.mocked(result.events.record)
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error("start event failed"));
      },
    },
    {
      name: "process failure",
      arrange(result: ReturnType<typeof setup>) {
        vi.mocked(result.instance.executePython).mockRejectedValueOnce(
          new Error("runner failed"),
        );
      },
    },
    {
      name: "artifact capture failure",
      arrange(result: ReturnType<typeof setup>) {
        result.artifacts.capture.mockRejectedValueOnce(
          new Error("capture failed"),
        );
      },
    },
  ])(
    "throws cancellation when cancellation wins $name finalization",
    async ({ name, arrange }) => {
      const result = setup();
      arrange(result);
      if (name === "pre-execution failure")
        vi.mocked(result.repository.releaseExecution).mockResolvedValueOnce(
          false,
        );
      else vi.mocked(result.repository.finishExecution).mockResolvedValueOnce(false);

      await expect(
        result.manager.executePython({
          scope: { runId: "run-failure-race", userId: "user-1" },
          profile,
          request: { code: "print('race')" },
          maxComputeMs: 1_000,
        }),
      ).rejects.toThrow("RUN_CANCELLED");
    },
  );

  it("throws cancellation when another path already finalized explicit cancellation", async () => {
    const result = setup();
    const scope = { runId: "run-cancel-race", userId: "user-1" };
    await result.manager.executePython({
      scope,
      profile,
      request: { code: "print('attached')" },
      maxComputeMs: 1_000,
    });
    vi.mocked(result.repository.finishExecution).mockResolvedValueOnce(false);

    await expect(
      result.manager.cancel({
        scope,
        profile,
        sessionId: result.sessions[0].id,
        executionId: [...result.executions.keys()][0],
      }),
    ).rejects.toThrow("RUN_CANCELLED");
  });

  it.each([0, 1])(
    "discards output and throws cancellation when cancellation wins exit code %i finalization",
    async (exitCode) => {
      const result = setup();
      const captured = [{ artifactId: "artifact-race" }];
      vi.mocked(result.instance.executePython).mockResolvedValueOnce({
        executionId: "provider-execution",
        exitCode,
        stdout: "output",
        stderr: "",
        durationMs: 10,
        files: [],
      });
      result.artifacts.capture.mockResolvedValueOnce(captured);
      vi.mocked(result.repository.finishExecution).mockResolvedValueOnce(false);

      await expect(
        result.manager.executePython({
          scope: { runId: `run-success-race-${exitCode}`, userId: "user-1" },
          profile,
          request: { code: "print('race')" },
          maxComputeMs: 1_000,
        }),
      ).rejects.toThrow("RUN_CANCELLED");
      expect(result.artifacts.discard).toHaveBeenCalledOnce();
      expect(result.artifacts.discard).toHaveBeenCalledWith(captured);
    },
  );
});
