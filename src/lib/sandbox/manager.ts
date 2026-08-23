import { randomUUID } from "node:crypto";
import type {
  PythonComputeRequest,
  PythonComputeResult,
  SandboxArtifactHook,
  SandboxEventSink,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxFileInput,
  SandboxInstance,
  SandboxListResult,
  SandboxOutputFile,
  SandboxPolicyAction,
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
const SESSION_REAP_RETRY_MS = 30_000;

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

  async reconcile(options?: { signal?: AbortSignal }) {
    // Use the control-plane clock for the destructive DB fence. Runner
    // capturedAt describes the inventory snapshot but may be clock-skewed.
    const reconciliationStartedAt = this.now();
    const inventory = await this.dependencies.provider.inventory(options);
    if (!Number.isFinite(new Date(inventory.capturedAt).getTime()))
      throw new Error("SANDBOX_INVENTORY_CAPTURE_TIME_INVALID");
    const byInstance = new Map(
      inventory.sessions.map((session) => [session.id, session]),
    );
    const sessions =
      await this.dependencies.repository.listSessionsForReconciliation(
        this.dependencies.provider.name,
        [...byInstance.keys()],
      );
    const byControlSession = new Map(
      sessions.map((session) => [session.id, session]),
    );
    let retained = 0;
    let destroyed = 0;
    let lost = 0;
    const retainedActiveInstances = new Set<string>();

    for (const runnerSession of inventory.sessions) {
      const session = byControlSession.get(runnerSession.controlPlaneSessionId);
      if (session && runnerSession.state === "live") {
        const decision = await this.dependencies.repository.reconcileSession({
          id: runnerSession.controlPlaneSessionId,
          rootRunId: runnerSession.rootRunId,
          provider: this.dependencies.provider.name,
          providerInstanceId: runnerSession.id,
          profile: profileFromInventory(runnerSession),
          expiresAt: new Date(runnerSession.expiresAt),
          creatorMayBeLive: runnerSession.bootId === inventory.bootId,
          reconciledAt: this.now(),
        });
        if (decision !== "rejected") {
          retained += 1;
          if (decision === "active")
            retainedActiveInstances.add(runnerSession.id);
          continue;
        }
      }
      await this.dependencies.provider
        .connect(runnerSession.id, profileFromInventory(runnerSession))
        .then((instance) => instance.destroy())
        .catch((error) => {
          if (
            !(
              error instanceof Error && error.message === "IRIS_RUNNER_HTTP_404"
            )
          )
            throw error;
        });
      destroyed += 1;
    }

    for (const session of sessions) {
      if (
        session.status !== "active" ||
        !session.providerInstanceId ||
        retainedActiveInstances.has(session.providerInstanceId)
      )
        continue;
      try {
        const instance = await this.dependencies.provider.connect(
          session.providerInstanceId,
          session.profile,
          {
            ...options,
            identity: {
              controlPlaneSessionId: session.id,
              rootRunId: session.rootRunId,
            },
          },
        );
        const retainedAfterLookup =
          await this.dependencies.repository.retainSessionAfterLookup({
            id: session.id,
            rootRunId: session.rootRunId,
            provider: this.dependencies.provider.name,
            providerInstanceId: session.providerInstanceId,
            profile: instance.profile,
          });
        if (!retainedAfterLookup) {
          await instance.destroy().catch(() => undefined);
          this.instances.delete(session.id);
          destroyed += 1;
          continue;
        }
        this.instances.set(session.id, instance);
        retained += 1;
        continue;
      } catch (error) {
        if (
          !(error instanceof Error && error.message === "IRIS_RUNNER_HTTP_404")
        )
          continue;
      }
      if (
        await this.dependencies.repository.markSessionLost(
          session.id,
          session.providerInstanceId,
          reconciliationStartedAt,
          this.now(),
        )
      )
        lost += 1;
    }
    return { retained, destroyed, lost, bootId: inventory.bootId };
  }

  async reconcileStaleExecutions(
    input: { before?: Date; limit?: number } = {},
  ) {
    return this.dependencies.repository.reconcileStaleExecutions(
      input.before ?? this.now(),
      Math.min(Math.max(input.limit ?? 100, 1), 500),
    );
  }

  executePython(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    request: PythonComputeRequest;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<PythonComputeResult & { artifacts: unknown[] }> {
    if (input.request.packages !== undefined) {
      return Promise.reject(new Error("SANDBOX_DYNAMIC_PACKAGES_DISABLED"));
    }
    return this.serialized(input.scope.runId, () => this.performPython(input));
  }

  execute(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    request: SandboxExecRequest;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecResult & { artifacts: unknown[] }> {
    return this.serialized(input.scope.runId, () =>
      this.performExecution({
        scope: input.scope,
        profile: input.profile,
        action: "sandbox.execute_cli",
        timeoutMs: input.request.timeoutMs,
        maxComputeMs: input.maxComputeMs,
        signal: input.signal,
        failureErrorCode: "SANDBOX_CLI_EXECUTION_FAILED",
        invoke: (instance) =>
          instance.exec(input.request, { signal: input.signal }),
      }),
    );
  }

  writeFiles(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    files: SandboxFileInput[];
    maxComputeMs?: number;
    signal?: AbortSignal;
  }) {
    return this.performFileOperation("sandbox.file.write", input, (instance) =>
      instance.writeFiles(input.files, { signal: input.signal }),
    );
  }

  readFile(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    path: string;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxOutputFile> {
    return this.performFileOperation("sandbox.file.read", input, (instance) =>
      instance.readFile(input.path, { signal: input.signal }),
    );
  }

  listFiles(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    path?: string;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxListResult> {
    return this.performFileOperation("sandbox.file.read", input, (instance) =>
      instance.listFiles(input.path ?? "/workspace", { signal: input.signal }),
    );
  }

  removePaths(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    paths: string[];
    maxComputeMs?: number;
    signal?: AbortSignal;
  }) {
    return this.performFileOperation("sandbox.file.remove", input, (instance) =>
      instance.removePaths(input.paths, { signal: input.signal }),
    );
  }

  createArchive(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    sourcePath: string;
    outputPath: string;
    maxFiles?: number;
    maxTotalBytes?: number;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecResult & { artifacts: unknown[] }> {
    return this.execute({
      scope: input.scope,
      profile: input.profile,
      request: {
        executable: "python",
        args: [
          "/usr/local/bin/sandbox-archive.py",
          "create",
          "--source",
          input.sourcePath,
          "--output",
          input.outputPath,
          "--max-files",
          String(Math.min(Math.max(input.maxFiles ?? 2_000, 1), 10_000)),
          "--max-total-bytes",
          String(
            Math.min(
              Math.max(input.maxTotalBytes ?? 100 * 1024 * 1024, 1),
              1024 * 1024 * 1024,
            ),
          ),
        ],
        cwd: "/workspace",
      },
      maxComputeMs: input.maxComputeMs,
      signal: input.signal,
    });
  }

  extractArchive(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    archivePath: string;
    destinationPath: string;
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxExecResult> {
    if (!input.archivePath.startsWith("/workspace/input/"))
      return Promise.reject(new Error("SANDBOX_ARCHIVE_INPUT_REQUIRED"));
    if (!input.destinationPath.startsWith("/workspace/work/"))
      return Promise.reject(new Error("SANDBOX_ARCHIVE_DESTINATION_REQUIRED"));
    return this.execute({
      scope: input.scope,
      profile: input.profile,
      request: {
        executable: "python",
        args: [
          "/usr/local/bin/sandbox-archive.py",
          "extract",
          "--archive",
          input.archivePath,
          "--destination",
          input.destinationPath,
          "--max-files",
          String(Math.min(Math.max(input.maxFiles ?? 2_000, 1), 10_000)),
          "--max-file-bytes",
          String(
            Math.min(
              Math.max(input.maxFileBytes ?? 25 * 1024 * 1024, 1),
              256 * 1024 * 1024,
            ),
          ),
          "--max-total-bytes",
          String(
            Math.min(
              Math.max(input.maxTotalBytes ?? 100 * 1024 * 1024, 1),
              1024 * 1024 * 1024,
            ),
          ),
        ],
        cwd: "/workspace",
      },
      maxComputeMs: input.maxComputeMs,
      signal: input.signal,
    });
  }

  private async performPython(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    request: PythonComputeRequest;
    maxComputeMs?: number;
    signal?: AbortSignal;
  }): Promise<PythonComputeResult & { artifacts: unknown[] }> {
    return (await this.performExecution({
      scope: input.scope,
      profile: input.profile,
      action: "sandbox.execute_python",
      timeoutMs: input.request.timeoutMs,
      maxComputeMs: input.maxComputeMs,
      signal: input.signal,
      failureErrorCode: "PYTHON_EXIT_NONZERO",
      invoke: (instance) =>
        instance.executePython({ ...input.request }, { signal: input.signal }),
    })) as unknown as Promise<PythonComputeResult & { artifacts: unknown[] }>;
  }

  private async performExecution(input: {
    scope: SandboxScope;
    profile: SandboxProfile;
    action: Extract<
      SandboxPolicyAction,
      "sandbox.execute_python" | "sandbox.execute_cli"
    >;
    timeoutMs?: number;
    maxComputeMs?: number;
    signal?: AbortSignal;
    failureErrorCode: string;
    invoke: (
      instance: SandboxInstance,
    ) => Promise<PythonComputeResult | SandboxExecResult>;
  }): Promise<
    (PythonComputeResult | SandboxExecResult) & { artifacts: unknown[] }
  > {
    await this.dependencies.policy.authorize({
      action: input.action,
      scope: input.scope,
      profile: input.profile,
    });
    const timeoutMs = Math.min(
      input.timeoutMs ?? input.profile.executionTimeoutMs,
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
      await this.touch(session, input.profile);
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
        "sandbox.execution_requested",
        input.scope,
        session.id,
        executionId,
        { requestedAt: reservedAt.toISOString() },
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
      await this.emit(
        "sandbox.execution_started",
        input.scope,
        session.id,
        executionId,
        { startedAt: startedAt.toISOString() },
      );
    } catch (error) {
      if (executionReserved && !executionStarted) {
        const completedAt = this.now();
        const released = await this.dependencies.repository
          .releaseExecution(executionId, reservationToken, {
            status: "failed",
            errorCode: "SANDBOX_PRE_EXECUTION_FAILED",
            completedAt,
          })
          .catch(() => true);
        if (!released) throw new Error("RUN_CANCELLED");
        await this.emit(
          "sandbox.execution_failed",
          input.scope,
          session!.id,
          executionId,
          {
            completedAt: completedAt.toISOString(),
            errorCode: "SANDBOX_PRE_EXECUTION_FAILED",
          },
        );
      }
      throw error;
    }

    let result: PythonComputeResult | SandboxExecResult;
    try {
      result = await input.invoke(instance);
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
      const completedAt = this.now();
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
          completedAt,
        },
      );
      if (!finalized) throw new Error("RUN_CANCELLED");
      await this.emit(
        cancelled ? "sandbox.execution_cancelled" : "sandbox.execution_failed",
        input.scope,
        session.id,
        executionId,
        {
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs,
          observedWallDurationMs,
        },
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
            files: result.files ?? [],
          })
        : [];
    } catch (error) {
      const completedAt = this.now();
      const artifactErrorCode =
        error instanceof Error &&
        /^SANDBOX_ARTIFACT_[A-Z_]+$/.test(error.message)
          ? error.message
          : "SANDBOX_ARTIFACT_CAPTURE_FAILED";
      const finalized = await this.dependencies.repository
        .finishExecution(executionId, {
          status: "failed",
          durationMs,
          observedWallDurationMs,
          exitCode: result.exitCode,
          errorCode: artifactErrorCode,
          completedAt,
        })
        .catch(() => true);
      if (!finalized) throw new Error("RUN_CANCELLED");
      await this.emit(
        "sandbox.execution_failed",
        input.scope,
        session.id,
        executionId,
        {
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          durationMs,
          observedWallDurationMs,
          exitCode: result.exitCode,
        },
      ).catch(() => undefined);
      throw error;
    }

    const status = result.exitCode === 0 ? "succeeded" : "failed";
    const completedAt = this.now();
    try {
      const finalized = await this.dependencies.repository.finishExecution(
        executionId,
        {
          status,
          durationMs,
          observedWallDurationMs,
          exitCode: result.exitCode,
          errorCode: result.exitCode === 0 ? undefined : input.failureErrorCode,
          completedAt,
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
      {
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        observedWallDurationMs,
        exitCode: result.exitCode,
      },
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
    const reconciledExecutions = await this.reconcileStaleExecutions({
      before,
      limit,
    });
    const cleanedArtifacts = await this.reapArtifactCleanup({ before, limit });
    const sessions = await this.dependencies.repository.claimExpiredSessions(
      before,
      limit,
      new Date(this.now().getTime() + SESSION_REAP_RETRY_MS),
    );
    let reapedSessions = 0;
    for (const session of sessions) {
      await this.dependencies.policy.authorize({
        action: "sandbox.reap",
        scope: session,
        profile: session.profile,
      });
      let instance: SandboxInstance | undefined;
      try {
        instance =
          this.instances.get(session.id) ??
          (session.providerInstanceId
            ? await this.dependencies.provider.connect(
                session.providerInstanceId,
                session.profile,
              )
            : undefined);
        await instance?.destroy();
      } catch (error) {
        // The destroying lease makes this session eligible for a later retry.
        if (
          !(error instanceof Error && error.message === "IRIS_RUNNER_HTTP_404")
        )
          continue;
      }
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
      reapedSessions += 1;
    }
    return reapedSessions + cleanedArtifacts + reconciledExecutions;
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
        {
          scope,
          profile,
          sessionId: session.id,
          rootRunId: claim.rootRunId,
        },
        { signal },
      );
      session.profile = instance.profile;
      session.expiresAt = instance.expiresAt ?? session.expiresAt;
      const activated = await this.dependencies.repository.activateSession(
        session.id,
        creatorToken,
        instance.id,
        session.expiresAt,
        this.now(),
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

  private async performFileOperation<T>(
    action: Extract<
      SandboxPolicyAction,
      "sandbox.file.read" | "sandbox.file.write" | "sandbox.file.remove"
    >,
    input: {
      scope: SandboxScope;
      profile: SandboxProfile;
      maxComputeMs?: number;
      signal?: AbortSignal;
    },
    operation: (instance: SandboxInstance) => Promise<T>,
  ): Promise<T> {
    const timeoutMs = Math.min(
      input.maxComputeMs ?? 10_000,
      input.profile.executionTimeoutMs,
    );
    await this.dependencies.policy.authorize({
      action,
      scope: input.scope,
      profile: input.profile,
    });
    return this.serialized(input.scope.runId, async () => {
      const { session, instance } = await this.session(
        input.scope,
        input.profile,
        input.signal,
      );
      await this.touch(session, input.profile);
      const executionId = this.generateId();
      const reservationToken = this.generateId();
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
        timeoutMs,
      );
      if (!reserved) throw new Error("RUN_CANCELLED");
      try {
        const result = await operation(instance);
        const completedAt = this.now();
        await this.dependencies.repository.settleExecution(
          executionId,
          reservationToken,
          Math.min(1, timeoutMs),
          Math.max(0, completedAt.getTime() - reservedAt.getTime()),
          completedAt,
        );
        await this.touch(session, input.profile);
        return result;
      } catch (error) {
        const completedAt = this.now();
        await this.dependencies.repository
          .settleExecution(
            executionId,
            reservationToken,
            Math.min(
              timeoutMs,
              Math.max(1, completedAt.getTime() - reservedAt.getTime()),
            ),
            Math.max(0, completedAt.getTime() - reservedAt.getTime()),
            completedAt,
          )
          .catch(() => undefined);
        throw error;
      }
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
    return this.dependencies.repository
      .touchSession(session.id, session.lastUsedAt, session.expiresAt)
      .then((touched) => {
        if (!touched) throw new Error("SANDBOX_SESSION_DESTROYING");
      });
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

function profileFromInventory(
  session: Awaited<
    ReturnType<SandboxProvider["inventory"]>
  >["sessions"][number],
): SandboxProfile {
  return {
    id: session.profile.id,
    network: session.profile.network,
    cpuMillis: Math.max(1, Math.floor(session.limits.nanoCpus / 1_000_000)),
    memoryMb: Math.max(1, Math.floor(session.limits.memoryBytes / 1_048_576)),
    diskMb: Math.max(1, Math.floor(session.limits.tmpfsBytes / 1_048_576)),
    pidsLimit: session.limits.pidsLimit,
    executionTimeoutMs: session.limits.executionTimeoutMs,
    idleTimeoutMs: session.limits.idleTimeoutMs,
    absoluteTimeoutMs: session.limits.absoluteTimeoutMs,
  };
}
