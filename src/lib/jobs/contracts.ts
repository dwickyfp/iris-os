export const DURABLE_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type DurableJobStatus = (typeof DURABLE_JOB_STATUSES)[number];

/**
 * A job is the durable execution envelope, not the thing being executed.
 * Keeping the target discriminated prevents agents, workflows, jobs, and tools
 * from becoming interchangeable domain concepts.
 */
export type DurableJobTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "workflow"; workflowId: string }
  | { kind: "job"; jobType: string }
  | { kind: "tool"; toolName: string };

export type DurableJobOutcome =
  | { status: "completed"; result?: unknown }
  | { status: "failed"; error: string; errorCode?: string };

export type DurableJobTerminalOutcome =
  | DurableJobOutcome
  | { status: "cancelled"; reason?: string };

export type DurableJobRunInbox = {
  runId: string;
  correlationId: string;
};

export type DurableJob = {
  id: string;
  idempotencyKey: string;
  target: DurableJobTarget;
  payload: unknown;
  status: DurableJobStatus;
  runInbox?: DurableJobRunInbox;
  attempt: number;
  leaseToken?: string;
  leaseExpiresAt?: Date;
  outcome?: DurableJobTerminalOutcome;
  createdAt: Date;
  updatedAt: Date;
};

export type TerminalDurableJob = DurableJob & {
  status: "completed" | "failed" | "cancelled";
  outcome: DurableJobTerminalOutcome;
};

export type CreateDurableJobInput = {
  id: string;
  idempotencyKey: string;
  target: DurableJobTarget;
  payload: unknown;
  runInbox?: DurableJobRunInbox;
};

export type DurableJobLease = {
  job: DurableJob & {
    status: "running";
    leaseToken: string;
    leaseExpiresAt: Date;
  };
  token: string;
};

export type DurableJobMutationResult =
  | { kind: "applied" | "replayed"; job: TerminalDurableJob }
  | { kind: "not_found" | "lease_lost" | "conflict" };

export type DurableJobHeartbeatResult =
  | { kind: "active"; lease: DurableJobLease }
  | { kind: "not_found" | "lease_lost" };

export interface DurableJobRepository {
  /** Atomically returns the existing job when idempotencyKey was seen before. */
  create(
    input: CreateDurableJobInput,
  ): Promise<{ kind: "created" | "existing"; job: DurableJob }>;

  /** Atomically claims a queued job or reclaims one whose lease has expired. */
  claim(input: {
    workerId: string;
    leaseDurationMs: number;
  }): Promise<DurableJobLease | null>;

  /** Extends only the currently active lease identified by leaseToken. */
  heartbeat(input: {
    jobId: string;
    leaseToken: string;
    leaseDurationMs: number;
  }): Promise<DurableJobHeartbeatResult>;

  /**
   * Applies an outcome only for the active lease. Repeating the same token and
   * outcome returns replayed; an older claim must return lease_lost.
   */
  finish(input: {
    jobId: string;
    leaseToken: string;
    outcome: DurableJobOutcome;
  }): Promise<DurableJobMutationResult>;

  /** Atomically cancels a non-terminal job and invalidates any active lease. */
  cancel(input: {
    jobId: string;
    reason?: string;
  }): Promise<DurableJobMutationResult>;
}

export type RunInboxCompletion = {
  idempotencyKey: string;
  runId: string;
  correlationId: string;
  jobId: string;
  target: DurableJobTarget;
  outcome: DurableJobTerminalOutcome;
};

export interface RunInbox {
  /** Must be idempotent by idempotencyKey. */
  injectCompletion(completion: RunInboxCompletion): Promise<void>;
}
