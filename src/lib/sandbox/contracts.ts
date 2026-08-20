export type SandboxProfile = {
  id: string;
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
  executionTimeoutMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs?: number;
  pidsLimit?: number;
  network: "none" | "egress";
};

export type SandboxRunnerSessionCreateRequest = {
  profile: {
    id: string;
    network: "none" | "egress";
  };
  limits: {
    cpuMillis: number;
    memoryMb: number;
    tmpfsMb: number;
    pidsLimit?: number;
    executionTimeoutMs: number;
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
  };
};

export type SandboxRunnerSessionLimits = {
  nanoCpus: number;
  memoryBytes: number;
  tmpfsBytes: number;
  pidsLimit: number;
  executionTimeoutMs: number;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
};

export type SandboxRunnerSessionResponse = {
  id: string;
  profile: { id: string; network: "none" | "egress" };
  limits: SandboxRunnerSessionLimits;
  createdAt: string;
  expiresAt: string;
};

export type SandboxProviderStatus = {
  ready: boolean;
  provider: string;
  reason?: string;
  checkedAt: Date;
};

export type SandboxScope = {
  runId: string;
  userId: string;
  workspaceId?: string;
  taskId?: string;
};

export type SandboxFileInput = {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
};

export type SandboxOutputFile = {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  mediaType?: string;
};

export type PythonComputeRequest = {
  code: string;
  files?: SandboxFileInput[];
  outputPaths?: string[];
  timeoutMs?: number;
};

export type PythonComputeResult = {
  executionId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  files: SandboxOutputFile[];
  metadata?: Record<string, unknown>;
};

export interface SandboxInstance {
  readonly id: string;
  readonly profile: SandboxProfile;
  readonly expiresAt?: Date;
  executePython(
    request: PythonComputeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PythonComputeResult>;
  cancel(executionId: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface SandboxProvider {
  readonly name: string;
  status(options?: { signal?: AbortSignal }): Promise<SandboxProviderStatus>;
  create(
    input: { scope: SandboxScope; profile: SandboxProfile },
    options?: { signal?: AbortSignal },
  ): Promise<SandboxInstance>;
  connect(
    instanceId: string,
    profile: SandboxProfile,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxInstance>;
}

export type SandboxSessionStatus =
  | "creating"
  | "active"
  | "destroying"
  | "destroyed"
  | "cancelled"
  | "failed";

export type SandboxExecutionStatus =
  | "reserved"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SandboxSessionRecord = SandboxScope & {
  id: string;
  provider: string;
  providerInstanceId?: string;
  profile: SandboxProfile;
  status: SandboxSessionStatus;
  lastUsedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  destroyedAt?: Date;
  errorCode?: string;
};

export type SandboxExecutionRecord = {
  id: string;
  sessionId: string;
  runId: string;
  status: SandboxExecutionStatus;
  reservationToken: string;
  reservedComputeMs: number;
  durationMs?: number;
  observedWallDurationMs?: number;
  exitCode?: number;
  errorCode?: string;
  reservationExpiresAt: Date;
  settlementDeadlineAt?: Date;
  chargedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
};

export interface SandboxRepository {
  claimSession(
    record: SandboxSessionRecord,
    creatorToken: string,
  ): Promise<{ session: SandboxSessionRecord; claimed: boolean }>;
  activateSession(
    id: string,
    creatorToken: string,
    providerInstanceId: string,
    expiresAt: Date,
    profile?: SandboxProfile,
  ): Promise<boolean>;
  failSessionCreation(
    id: string,
    creatorToken: string,
    input: { errorCode: string; destroyedAt: Date },
  ): Promise<void>;
  cancelSessionsByRun(
    runId: string,
    provider: string,
    completedAt: Date,
  ): Promise<SandboxSessionRecord[]>;
  cancelSessionsByRootRun(
    rootRunId: string,
    provider: string,
    completedAt: Date,
  ): Promise<SandboxSessionRecord[]>;
  touchSession(id: string, lastUsedAt: Date, expiresAt: Date): Promise<void>;
  finishSession(
    id: string,
    status: "destroyed" | "failed",
    input?: { errorCode?: string; destroyedAt?: Date },
  ): Promise<void>;
  listExpiredSessions(
    before: Date,
    limit: number,
  ): Promise<SandboxSessionRecord[]>;
  reserveExecution(
    record: SandboxExecutionRecord,
    maxComputeMs: number,
  ): Promise<boolean>;
  startExecution(
    id: string,
    reservationToken: string,
    startedAt: Date,
    settlementDeadlineAt: Date,
  ): Promise<boolean>;
  releaseExecution(
    id: string,
    reservationToken: string,
    input: Pick<
      SandboxExecutionRecord,
      "status" | "errorCode" | "completedAt"
    >,
  ): Promise<boolean>;
  settleExecution(
    id: string,
    reservationToken: string,
    durationMs: number,
    observedWallDurationMs: number,
    chargedAt: Date,
  ): Promise<boolean>;
  finishExecution(
    id: string,
    input: Pick<
      SandboxExecutionRecord,
      | "status"
      | "durationMs"
      | "observedWallDurationMs"
      | "exitCode"
      | "errorCode"
      | "completedAt"
    >,
  ): Promise<boolean>;
  cancelRunningExecutions(
    sessionId: string,
    errorCode: string,
    completedAt: Date,
  ): Promise<void>;
}

export type SandboxPolicyAction =
  | "sandbox.create"
  | "sandbox.execute_python"
  | "sandbox.cancel"
  | "sandbox.destroy"
  | "sandbox.reap";

export interface SandboxPolicyGate {
  authorize(input: {
    action: SandboxPolicyAction;
    scope: SandboxScope;
    profile: SandboxProfile;
  }): Promise<void>;
}

export interface SandboxEventSink {
  record(input: {
    type:
      | "sandbox.session_created"
      | "sandbox.session_reused"
      | "sandbox.execution_started"
      | "sandbox.execution_completed"
      | "sandbox.execution_failed"
      | "sandbox.execution_cancelled"
      | "sandbox.session_destroyed"
      | "sandbox.session_reaped";
    scope: SandboxScope;
    sessionId: string;
    executionId?: string;
    payload?: Record<string, unknown>;
  }): Promise<void>;
}

export interface SandboxArtifactHook {
  capture(input: {
    scope: SandboxScope;
    sessionId: string;
    executionId: string;
    files: SandboxOutputFile[];
  }): Promise<unknown[]>;
  discard?(artifacts: unknown[]): Promise<void>;
  reapCleanup?(input?: { before?: Date; limit?: number }): Promise<number>;
}
