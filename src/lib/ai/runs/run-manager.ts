import "server-only";

import type { AgentRunRepository } from "./agent-run-repository";
import type {
  QueueDelegatedRunInput,
  RunOutcome,
  StartRunInput,
} from "./types";

export class RunManager {
  private readonly foregroundLeases = new Map<string, string>();

  constructor(private readonly repository: AgentRunRepository) {}

  async start(input: StartRunInput) {
    const run = await this.repository.createRunning(input);
    if (run.leaseToken) this.foregroundLeases.set(run.id, run.leaseToken);
    return run;
  }

  queueDelegated(input: QueueDelegatedRunInput) {
    return this.repository.createDelegated(input);
  }

  claim(runId: string, leaseMs = 30_000) {
    return this.repository.claimQueued(runId, leaseMs);
  }

  heartbeat(runId: string, leaseToken: string, leaseMs = 30_000) {
    return this.repository.heartbeat(runId, leaseToken, leaseMs);
  }

  waitForInput(
    runId: string,
    leaseToken: string,
    reason = "REMOTE_INPUT_REQUIRED",
  ) {
    return this.repository.wait(runId, "waiting_input", reason, leaseToken);
  }

  waitForApproval(
    runId: string,
    leaseToken: string,
    reason = "REMOTE_AUTH_REQUIRED",
  ) {
    return this.repository.wait(runId, "waiting_approval", reason, leaseToken);
  }

  waitForExternal(
    runId: string,
    leaseToken: string,
    reason = "REMOTE_WORKING",
  ) {
    return this.repository.wait(runId, "waiting_external", reason, leaseToken);
  }

  resume(input: Parameters<AgentRunRepository["resume"]>[0]) {
    return this.repository.resume(input);
  }

  consumeContinuation(runId: string, leaseToken: string) {
    return this.repository.consumeContinuation(runId, leaseToken);
  }

  consumeContinuationMessage(
    runId: string,
    leaseToken: string,
    submissionId: string,
  ) {
    return this.repository.consumeContinuationMessage(
      runId,
      leaseToken,
      submissionId,
    );
  }

  selectTransientCredential(runId: string, leaseToken: string) {
    return this.repository.selectTransientCredential(runId, leaseToken);
  }

  prepareRemoteSubmission(runId: string, leaseToken: string) {
    return this.repository.prepareRemoteSubmission(runId, leaseToken);
  }

  recordRemoteTask(
    runId: string,
    leaseToken: string,
    task: {
      id: string;
      contextId?: string;
      state: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    return this.repository.recordRemoteTask(runId, leaseToken, task);
  }

  deferRemoteTask(
    runId: string,
    leaseToken: string,
    task: {
      id: string;
      contextId?: string;
      state: string;
      metadata?: Record<string, unknown>;
    },
    reason = "REMOTE_WORKING",
    availableAt = new Date(),
  ) {
    return this.repository.deferRemoteTask(
      runId,
      leaseToken,
      reason,
      task,
      availableAt,
    );
  }

  succeed(runId: string, result: Record<string, unknown>) {
    const leaseToken = this.foregroundLeases.get(runId);
    if (!leaseToken) return Promise.resolve(null);
    return this.finish(runId, leaseToken, { status: "succeeded", result });
  }

  fail(runId: string, error: string, errorCode?: string) {
    const leaseToken = this.foregroundLeases.get(runId);
    if (!leaseToken) return Promise.resolve(null);
    return this.finish(runId, leaseToken, {
      status: "failed",
      error,
      errorCode,
    });
  }

  cancel(runId: string, error?: string, errorCode?: string) {
    const leaseToken = this.foregroundLeases.get(runId);
    if (!leaseToken) return Promise.resolve(null);
    return this.finish(runId, leaseToken, {
      status: "cancelled",
      error,
      errorCode,
    });
  }

  timeOut(runId: string, error?: string, errorCode?: string) {
    const leaseToken = this.foregroundLeases.get(runId);
    if (!leaseToken) return Promise.resolve(null);
    return this.finish(runId, leaseToken, {
      status: "timed_out",
      error,
      errorCode,
    });
  }

  succeedWithLease(
    runId: string,
    leaseToken: string,
    result: Record<string, unknown>,
  ) {
    return this.finish(runId, leaseToken, { status: "succeeded", result });
  }

  failWithLease(
    runId: string,
    leaseToken: string,
    error: string,
    errorCode?: string,
  ) {
    return this.finish(runId, leaseToken, {
      status: "failed",
      error,
      errorCode,
    });
  }

  cancelWithLease(
    runId: string,
    leaseToken: string,
    error?: string,
    errorCode?: string,
  ) {
    return this.finish(runId, leaseToken, {
      status: "cancelled",
      error,
      errorCode,
    });
  }

  timeOutWithLease(
    runId: string,
    leaseToken: string,
    error?: string,
    errorCode?: string,
  ) {
    return this.finish(runId, leaseToken, {
      status: "timed_out",
      error,
      errorCode,
    });
  }

  cancelQueued(
    runId: string,
    details?: { error?: string; errorCode?: string },
  ) {
    return this.repository.cancelQueued(runId, details);
  }

  requestCancellation(runId: string, userId: string) {
    return this.repository.requestCancellationTree(runId, userId);
  }

  prepareRemoteCancellation(runId: string) {
    return this.repository.prepareRemoteCancellation(runId);
  }

  recordRemoteCancellation(
    runId: string,
    outcome: Parameters<AgentRunRepository["recordRemoteCancellation"]>[1],
  ) {
    return this.repository.recordRemoteCancellation(runId, outcome);
  }

  isCancellationRequested(runIds: readonly string[]) {
    return this.repository.isCancellationRequested(runIds);
  }

  countRunningChildren(parentRunId: string) {
    return this.repository.countRunningChildren(parentRunId);
  }

  listStaleDelegatedRunIds(before: Date, limit = 100) {
    return this.repository.listStaleDelegatedRunIds(before, limit);
  }

  listPendingDispatchRunIds(limit = 100) {
    return this.repository.listPendingDispatchRunIds(limit);
  }

  markDispatched(runId: string) {
    return this.repository.markDispatched(runId);
  }

  listPendingRemoteCancellationRunIds(limit = 100) {
    return this.repository.listPendingRemoteCancellationRunIds(limit);
  }

  markRemoteCancellationDispatched(runId: string) {
    return this.repository.markRemoteCancellationDispatched(runId);
  }

  suspendParent(
    runId: string,
    leaseToken: string,
    checkpoint: Parameters<AgentRunRepository["suspendParent"]>[2],
  ) {
    return this.repository.suspendParent(runId, leaseToken, checkpoint);
  }

  claimParentResume(runId: string, leaseMs = 30_000) {
    return this.repository.claimParentResume(runId, leaseMs);
  }

  checkpointParentAgain(
    runId: string,
    claimToken: string,
    checkpoint: Parameters<AgentRunRepository["checkpointParentAgain"]>[2],
  ) {
    return this.repository.checkpointParentAgain(runId, claimToken, checkpoint);
  }

  finishParentResume(
    runId: string,
    claimToken: string,
    outcome: Parameters<AgentRunRepository["finishParentResume"]>[2],
  ) {
    return this.repository.finishParentResume(runId, claimToken, outcome);
  }

  listPendingParentResumeIds(limit = 100) {
    return this.repository.listPendingParentResumeIds(limit);
  }

  markParentResumeDispatched(runId: string) {
    return this.repository.markParentResumeDispatched(runId);
  }

  private finish(runId: string, leaseToken: string, outcome: RunOutcome) {
    this.foregroundLeases.delete(runId);
    return this.repository.finishRunning(runId, leaseToken, outcome);
  }
}
