import type {
  AgentRun,
  QueueDelegatedRunInput,
  RemoteSubmissionIntent,
  RemoteCancellationIntent,
  ResumeRunInput,
  RunContinuation,
  RunLease,
  RunLeaseState,
  RunOutcome,
  StartRunInput,
  ParentRunCheckpoint,
  ClaimedParentRun,
} from "./types";

export interface AgentRunRepository {
  createRunning(input: StartRunInput): Promise<AgentRun>;
  createDelegated(input: QueueDelegatedRunInput): Promise<AgentRun>;
  selectById(id: string, userId?: string): Promise<AgentRun | null>;
  claimQueued(id: string, leaseMs: number): Promise<RunLease | null>;
  heartbeat(
    id: string,
    leaseToken: string,
    leaseMs: number,
  ): Promise<RunLeaseState>;
  finishRunning(
    id: string,
    leaseToken: string,
    outcome: RunOutcome,
  ): Promise<AgentRun | null>;
  wait(
    id: string,
    status: "waiting_approval" | "waiting_input" | "waiting_external",
    reason: string,
    leaseToken: string,
  ): Promise<AgentRun | null>;
  resume(input: ResumeRunInput): Promise<AgentRun | null>;
  consumeContinuation(
    id: string,
    leaseToken: string,
  ): Promise<RunContinuation | null>;
  consumeContinuationMessage(
    id: string,
    leaseToken: string,
    submissionId: string,
  ): Promise<boolean>;
  selectTransientCredential(
    id: string,
    leaseToken: string,
  ): Promise<string | null>;
  prepareRemoteSubmission(
    id: string,
    leaseToken: string,
  ): Promise<RemoteSubmissionIntent | null>;
  recordRemoteTask(
    id: string,
    leaseToken: string,
    task: {
      id: string;
      contextId?: string;
      state: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<boolean>;
  deferRemoteTask(
    id: string,
    leaseToken: string,
    reason: string,
    task: {
      id: string;
      contextId?: string;
      state: string;
      metadata?: Record<string, unknown>;
    },
    availableAt: Date,
  ): Promise<AgentRun | null>;
  cancelQueued(
    id: string,
    details?: { error?: string; errorCode?: string },
  ): Promise<AgentRun | null>;
  requestCancellationTree(id: string, userId: string): Promise<AgentRun | null>;
  prepareRemoteCancellation(id: string): Promise<RemoteCancellationIntent | null>;
  recordRemoteCancellation(
    id: string,
    outcome:
      | {
          ok: true;
          task: { id: string; state: string; contextId?: string };
          retryAt?: Date;
        }
      | { ok: false; error: string; retryAt: Date },
  ): Promise<AgentRun | null>;
  isCancellationRequested(ids: readonly string[]): Promise<boolean>;
  countRunningChildren(parentRunId: string): Promise<number>;
  listStaleDelegatedRunIds(before: Date, limit: number): Promise<string[]>;
  listPendingDispatchRunIds(limit: number): Promise<string[]>;
  markDispatched(id: string): Promise<void>;
  listPendingRemoteCancellationRunIds(limit: number): Promise<string[]>;
  markRemoteCancellationDispatched(id: string): Promise<void>;
  suspendParent(
    id: string,
    leaseToken: string,
    checkpoint: ParentRunCheckpoint,
  ): Promise<AgentRun | null>;
  claimParentResume(id: string, leaseMs: number): Promise<ClaimedParentRun | null>;
  checkpointParentAgain(
    id: string,
    claimToken: string,
    checkpoint: ParentRunCheckpoint,
  ): Promise<AgentRun | null>;
  finishParentResume(
    id: string,
    claimToken: string,
    outcome: RunOutcome,
  ): Promise<AgentRun | null>;
  listPendingParentResumeIds(limit: number): Promise<string[]>;
  markParentResumeDispatched(id: string): Promise<void>;
}
