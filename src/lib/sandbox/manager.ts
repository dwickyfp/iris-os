import { randomUUID } from "node:crypto";
import type {
  PythonComputeRequest,
  PythonComputeResult,
  SandboxArtifactHook,
  SandboxEventSink,
  SandboxInstance,
  SandboxPolicyGate,
  SandboxProfile,
  SandboxProvider,
  SandboxRepository,
  SandboxScope,
  SandboxSessionRecord,
} from "./contracts";

export type SandboxManagerDependencies = {
  provider: SandboxProvider;
  repository: SandboxRepository;
  policy: SandboxPolicyGate;
  events?: SandboxEventSink;
  artifacts?: SandboxArtifactHook;
  now?: () => Date;
  generateId?: () => string;
};

const RESERVATION_LEASE_MS = 60_000;
const SETTLEMENT_GRACE_MS = 60_000;

export class SandboxManager {
  private readonly instances = new Map<string, SandboxInstance>();
  private readonly pending = new Map<
    string,
    Promise<{ session: SandboxSessionRecord; instance: SandboxInstance }>
  >();
  private readonly executionLocks = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(private readonly dependencies: SandboxManagerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.generateId = dependencies.generateId ?? randomUUID;
  }

  executePython(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    request: PythonComputeRequest;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<PythonComputeResult & { artifacts: unknown[] }> {
    return this.serialized(input.scope.runId, () => this.performPython(input));
  }

  private async performPython(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    request: PythonComputeRequest;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<PythonComputeResult & { artifacts: unknown[] }> {
    await this.dependencies.policy.authorize({
      action: "sandbox.execute_python",
      scope: input.scope,
      profile: input.profile,
    });
    const timeoutMs = Math.min(
      input.request.timeoutMs ?? input.profile.executionTimeoutMs,
      input.profile.executionTimeoutMs,
    );
    let session: SandboxSessionRecord;
    let instance: SandboxInstance;
    const executionId = this.generateId();
    const reservationToken = this.generateId();
    const maxComputeMs = input.maxComputeMs ?? timeoutMs;
    let startedAt: Date | undefined;
    let executionReserved = false;
    let executionStarted = false;

    try {
      ({ session, instance } = await this.session(
        input.scope,
        input.profile,
        input.signal,
      ));
      const reservedAt = this.now();
      const reserved = await this.dependencies.repository.reserveExecution(
        {
          id: executionId,
          sessionId: session.id,
          runId: input.scope.runId,
          status: "reserved",
          reservationToken,
          reservedComputeMs: timeoutMs,
          reservationExpiresAt: new Date(
            reservedAt.getTime() + RESERVATION_LEASE_MS,
          ),
        },
        maxComputeMs,
      );
      if (!reserved) throw new Error("RUN_CANCELLED");
      executionReserved = true;
      await this.emit(
        "sandbox.execution_started",
        input.scope,
        session.id,
        executionId,
      );
      const candidateStartedAt = this.now();
      const started = await this.dependencies.repository.startExecution(
        executionId,
        reservationToken,
        candidateStartedAt,
        new Date(
          candidateStartedAt.getTime() + timeoutMs + SETTLEMENT_GRACE_MS,
        ),
      );
      if (!started) throw new Error("RUN_CANCELLED");
      startedAt = candidateStartedAt;
      executionStarted = true;
    } catch (error) {
      if (executionReserved && !executionStarted) {
        const released = await this.dependencies.repository
          .releaseExecution(executionId, reservationToken, {
            status: "failed",
            errorCode: "SANDBOX_PRE_EXECUTION_FAILED",
            completedAt: this.now(),
          })
          .catch(() => true);
        if (!released) throw new Error("RUN_CANCELLED");
      }
      throw error;
    }

    let result: PythonComputeResult;
    try {
      result = await instance.executePython(
        { ...input.request, timeoutMs },
        { signal: input.signal },
      );
    } catch (error) {
      const observedWallDurationMs = Math.max(
        0,
        this.now().getTime() - startedAt.getTime(),
      );
      const durationMs = Math.min(observedWallDurationMs, timeoutMs);
      await this.dependencies.repository.settleExecution(
        executionId,
        reservationToken,
        durationMs,
        observedWallDurationMs,
        this.now(),
      );
      const cancelled = input.signal?.aborted === true;
      const timedOut =
        error instanceof Error && error.message === "IRIS_RUNNER_HTTP_408";
      const sessionGone =
        cancelled ||
        timedOut ||
        (error instanceof Error && error.message === "IRIS_RUNNER_HTTP_404");
      const finalized = await this.dependencies.repository.finishExecution(
        executionId,
        {
          status: cancelled ? "cancelled" : timedOut ? "timed_out" : "failed",
          durationMs,
          observedWallDurationMs,
          errorCode: cancelled
            ? "CANCELLED"
            : timedOut
              ? "SANDBOX_TIMED_OUT"
              : "SANDBOX_EXECUTION_FAILED",
          completedAt: this.now(),
        },
      );
      if (!finalized) throw new Error("RUN_CANCELLED");
      await this.emit(
        cancelled ? "sandbox.execution_cancelled" : "sandbox.execution_failed",
        input.scope,
        session.id,
        executionId,
        { durationMs, observedWallDurationMs },
      );
      if (sessionGone) {
        this.instances.delete(session.id);
        await this.dependencies.repository
          .finishSession(session.id, "failed", {
            destroyedAt: this.now(),
            errorCode: cancelled
              ? "RUN_CANCELLED"
              : timedOut
                ? "SANDBOX_TIMED_OUT"
                : "SANDBOX_SESSION_LOST",
          })
          .catch(() => undefined);
      }
      throw error;
    }

    const observedWallDurationMs = Math.max(0, Math.ceil(result.durationMs));
    const durationMs = Math.min(observedWallDurationMs, timeoutMs);
    await this.dependencies.repository.settleExecution(
      executionId,
      reservationToken,
      durationMs,
      observedWallDurationMs,
      this.now(),
    );
    let artifacts: unknown[];
    try {
      artifacts = this.dependencies.artifacts
        ? await this.dependencies.artifacts.capture({
            scope: input.scope,
            sessionId: session.id,
            executionId,
            files: result.files,
          })
        : [];
    } catch (error) {
      const finalized = await this.dependencies.repository
        .finishExecution(executionId, {
          status: "failed",
          durationMs,
          observedWallDurationMs,
          exitCode: result.exitCode,
          errorCode: "SANDBOX_ARTIFACT_CAPTURE_FAILED",
          completedAt: this.now(),
        })
        .catch(() => true);
      if (!finalized) throw new Error("RUN_CANCELLED");
      await this.emit(
        "sandbox.execution_failed",
        input.scope,
        session.id,
        executionId,
        { durationMs, observedWallDurationMs, exitCode: result.exitCode },
      ).catch(() => undefined);
      throw error;
    }

    const status = result.exitCode === 0 ? "succeeded" : "failed";
    try {
      const finalized = await this.dependencies.repository.finishExecution(
        executionId,
        {
          status,
          durationMs,
          observedWallDurationMs,
          exitCode: result.exitCode,
          errorCode: result.exitCode === 0 ? undefined : "PYTHON_EXIT_NONZERO",
          completedAt: this.now(),
        },
      );
      if (!finalized) {
        throw new Error("RUN_CANCELLED");
      }
    } catch (error) {
      await this.dependencies.artifacts?.discard?.(artifacts);
      throw error;
    }
    await this.touch(session, input.profile);
    await this.emit(
      result.exitCode === 0
        ? "sandbox.execution_completed"
        : "sandbox.execution_failed",
      input.scope,
      session.id,
      executionId,
      { durationMs, observedWallDurationMs, exitCode: result.exitCode },
    );
    return { ...result, executionId, artifacts };
  }

  async cancel(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    sessionId: string;
    executionId: string;
  }) {
    await this.dependencies.policy.authorize({
      action: "sandbox.cancel",
      scope: input.scope,
      profile: input.profile,
    });
    const instance = this.instances.get(input.sessionId);
    if (!instance) throw new Error("SANDBOX_SESSION_NOT_ATTACHED");
    await instance.cancel(input.executionId);
    this.instances.delete(input.sessionId);
    const finalized = await this.dependencies.repository.finishExecution(
      input.executionId,
      {
        status: "cancelled",
        durationMs: 0,
        errorCode: "CANCELLED",
        completedAt: this.now(),
      },
    );
    if (!finalized) throw new Error("RUN_CANCELLED");
    await this.dependencies.repository.finishSession(
      input.sessionId,
      "destroyed",
      {
        destroyedAt: this.now(),
        errorCode: "RUN_CANCELLED",
      },
    );
    await this.emit(
      "sandbox.execution_cancelled",
      input.scope,
      input.sessionId,
      input.executionId,
    );
  }

  async cancelByRun(runId: string) {
    const cancelledAt = this.now();
    const sessions = await this.dependencies.repository.cancelSessionsByRun(
      runId,
      this.dependencies.provider.name,
      cancelledAt,
    );
    await Promise.all(
      sessions.map((session) => this.destroyCancelled(session)),
    );
    return sessions.length > 0;
  }

  async cancelByRootRun(rootRunId: string) {
    const sessions = await this.dependencies.repository.cancelSessionsByRootRun(
      rootRunId,
      this.dependencies.provider.name,
      this.now(),
    );
    await Promise.all(
      sessions.map((session) => this.destroyCancelled(session)),
    );
    return sessions.length;
  }

  async destroy(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    sessionId: string;
  }) {
    await this.dependencies.policy.authorize({
      action: "sandbox.destroy",
      scope: input.scope,
      profile: input.profile,
    });
    const instance = this.instances.get(input.sessionId);
    if (instance) await instance.destroy();
    this.instances.delete(input.sessionId);
    const destroyedAt = this.now();
    await this.dependencies.repository.finishSession(
      input.sessionId,
      "destroyed",
      {
        destroyedAt,
      },
    );
    await this.dependencies.repository.cancelRunningExecutions(
      input.sessionId,
      "SANDBOX_DESTROYED",
      destroyedAt,
    );
    await this.emit("sandbox.session_destroyed", input.scope, input.sessionId);
  }

  async reap(input: { before?: Date; limit?: number } = {}) {
    const before = input.before ?? this.now();
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const cleanedArtifacts = await this.reapArtifactCleanup({ before, limit });
    const sessions = await this.dependencies.repository.listExpiredSessions(
      before,
      limit,
    );
    for (const session of sessions) {
      await this.dependencies.policy.authorize({
        action: "sandbox.reap",
        scope: session,
        profile: session.profile,
      });
      const instance =
        this.instances.get(session.id) ??
        (session.providerInstanceId
          ? await this.dependencies.provider.connect(
              session.providerInstanceId,
              session.profile,
            )
          : undefined);
      await instance?.destroy().catch(() => undefined);
      this.instances.delete(session.id);
      await this.dependencies.repository.finishSession(
        session.id,
        "destroyed",
        {
          destroyedAt: this.now(),
        },
      );
      await this.dependencies.repository.cancelRunningExecutions(
        session.id,
        "SANDBOX_REAPED",
        this.now(),
      );
      await this.emit("sandbox.session_reaped", session, session.id);
    }
    return sessions.length + cleanedArtifacts;
  }

  async reapArtifactCleanup(input: { before?: Date; limit?: number } = {}) {
    return (
      (await this.dependencies.artifacts?.reapCleanup?.({
        before: input.before ?? this.now(),
        limit: Math.min(Math.max(input.limit ?? 100, 1), 500),
      })) ?? 0
    );
  }

  private async session(
    scope: SandboxScope,
    profile: SandboxProfile,
    signal?: AbortSignal,
  ) {
    const key = `${scope.runId}:${this.dependencies.provider.name}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = this.openSession(scope, profile, signal).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, pending);
    return pending;
  }

  private async openSession(
    scope: SandboxScope,
    profile: SandboxProfile,
    signal?: AbortSignal,
  ) {
    const now = this.now();
    const candidate: SandboxSessionRecord = {
      ...scope,
      id: this.generateId(),
      provider: this.dependencies.provider.name,
      profile,
      status: "creating",
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + profile.idleTimeoutMs),
      createdAt: now,
    };
    const creatorToken = this.generateId();
    const claim = await this.dependencies.repository.claimSession(
      candidate,
      creatorToken,
    );
    const persisted = claim.session;
    if (persisted.status === "cancelled") throw new Error("RUN_CANCELLED");
    if (persisted.status === "creating" && !claim.claimed) {
      await this.waitForCreator(signal);
      return this.openSession(scope, profile, signal);
    }
    if (persisted.status === "active" && persisted.providerInstanceId) {
      try {
        const instance =
          this.instances.get(persisted.id) ??
          (await this.dependencies.provider.connect(
            persisted.providerInstanceId,
            persisted.profile,
            { signal },
          ));
        persisted.profile = instance.profile;
        persisted.expiresAt = instance.expiresAt ?? persisted.expiresAt;
        this.instances.set(persisted.id, instance);
        await this.touch(persisted, persisted.profile);
        await this.emit("sandbox.session_reused", scope, persisted.id);
        return { session: persisted, instance };
      } catch (error) {
        this.instances.delete(persisted.id);
        await this.dependencies.repository.finishSession(
          persisted.id,
          "failed",
          {
            destroyedAt: this.now(),
            errorCode: "SANDBOX_SESSION_LOST",
          },
        );
        if (
          !(error instanceof Error && error.message === "IRIS_RUNNER_HTTP_404")
        )
          throw error;
      }
    }

    if (!claim.claimed) return this.openSession(scope, profile, signal);

    const session = persisted;
    let instance: SandboxInstance | undefined;
    try {
      await this.dependencies.policy.authorize({
        action: "sandbox.create",
        scope,
        profile,
      });
      const providerStatus = await this.dependencies.provider.status({
        signal,
      });
      if (!providerStatus.ready)
        throw new Error(
          providerStatus.reason ?? "SANDBOX_PROVIDER_UNAVAILABLE",
        );
      instance = await this.dependencies.provider.create(
        { scope, profile },
        { signal },
      );
      session.profile = instance.profile;
      session.expiresAt = instance.expiresAt ?? session.expiresAt;
      const activated = await this.dependencies.repository.activateSession(
        session.id,
        creatorToken,
        instance.id,
        session.expiresAt,
        instance.profile,
      );
      if (!activated) {
        await instance.destroy().catch(() => undefined);
        throw new Error("RUN_CANCELLED");
      }
      this.instances.set(session.id, instance);
      session.status = "active";
      session.providerInstanceId = instance.id;
      await this.emit("sandbox.session_created", scope, session.id);
      return { session, instance };
    } catch (error) {
      if (
        instance &&
        error instanceof Error &&
        error.message !== "RUN_CANCELLED"
      )
        await instance.destroy().catch(() => undefined);
      await this.dependencies.repository.failSessionCreation(
        session.id,
        creatorToken,
        {
          errorCode: "SANDBOX_CREATE_FAILED",
          destroyedAt: this.now(),
        },
      );
      throw error;
    }
  }

  private async destroyCancelled(session: SandboxSessionRecord) {
    const instance =
      this.instances.get(session.id) ??
      (session.providerInstanceId
        ? await this.dependencies.provider
            .connect(session.providerInstanceId, session.profile)
            .catch(() => undefined)
        : undefined);
    await instance?.destroy().catch(() => undefined);
    this.instances.delete(session.id);
    await this.emit(
      "sandbox.session_destroyed",
      session,
      session.id,
      undefined,
      { reason: "run_cancelled" },
    );
  }

  private waitForCreator(signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 25);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  private touch(session: SandboxSessionRecord, profile: SandboxProfile) {
    const now = this.now();
    session.lastUsedAt = now;
    const idleExpiry = now.getTime() + profile.idleTimeoutMs;
    const absoluteExpiry =
      session.createdAt.getTime() +
      (profile.absoluteTimeoutMs ?? profile.idleTimeoutMs * 3);
    session.expiresAt = new Date(Math.min(idleExpiry, absoluteExpiry));
    return this.dependencies.repository.touchSession(
      session.id,
      session.lastUsedAt,
      session.expiresAt,
    );
  }

  private serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.executionLocks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.executionLocks.set(key, current);
    return current.finally(() => {
      if (this.executionLocks.get(key) === current)
        this.executionLocks.delete(key);
    });
  }

  private emit(
    type: Parameters<
      NonNullable<SandboxManagerDependencies["events"]>["record"]
    >[0]["type"],
    scope: SandboxScope,
    sessionId: string,
    executionId?: string,
    payload?: Record<string, unknown>,
  ) {
    return (
      this.dependencies.events?.record({
        type,
        scope,
        sessionId,
        executionId,
        payload,
      }) ?? Promise.resolve()
    );
  }
}
