import type {
  A2ASendResult,
  A2ATask,
  RemoteAgentCredential,
} from "app-types/remote-agent";
import { sanitizeActivityPayload } from "lib/activity/sanitize";
import type { ArtifactReference } from "lib/ai/artifacts";
import type {
  AgentRun,
  RunContinuation,
  RunLeaseState,
} from "lib/ai/runs/types";
import {
  isActiveAgentRunStatus,
  isTerminalAgentRunStatus,
} from "lib/ai/runs/status";
import type { AutomationExecutionResult } from "lib/automation/execution-adapter";
import {
  type AbortCause,
  classifyAbortedExecution,
} from "lib/delegation/execution-outcome";

type Delegation = {
  targetKind: "local_agent" | "remote_agent";
  remoteAgentId: string | null;
};

type RemoteService = {
  sendTask(
    userId: string,
    remoteAgentId: string,
    input: unknown,
    options?: { requestId?: string; credential?: RemoteAgentCredential },
  ): Promise<A2ASendResult>;
  continueTask(
    userId: string,
    remoteAgentId: string,
    input: unknown,
    options: { requestId: string; credential?: RemoteAgentCredential },
  ): Promise<A2ASendResult>;
  getTask(
    userId: string,
    remoteAgentId: string,
    taskId: string,
    credential?: RemoteAgentCredential,
  ): Promise<A2ATask>;
  cancelTask(
    userId: string,
    remoteAgentId: string,
    taskId: string,
    credential?: RemoteAgentCredential,
  ): Promise<A2ATask>;
};

type RunManagerDependency = {
  claim(runId: string): Promise<{ run: AgentRun; token: string } | null>;
  heartbeat(runId: string, token: string): Promise<RunLeaseState>;
  waitForInput(runId: string, token: string): Promise<AgentRun | null>;
  waitForApproval(runId: string, token: string): Promise<AgentRun | null>;
  deferRemoteTask(
    runId: string,
    token: string,
    task: {
      id: string;
      contextId?: string;
      state: string;
      metadata?: Record<string, unknown>;
    },
    reason?: string,
    availableAt?: Date,
  ): Promise<AgentRun | null>;
  consumeContinuation(
    runId: string,
    token: string,
  ): Promise<RunContinuation | null>;
  consumeContinuationMessage(
    runId: string,
    token: string,
    submissionId: string,
  ): Promise<boolean>;
  selectTransientCredential(
    runId: string,
    token: string,
  ): Promise<string | null>;
  prepareRemoteSubmission(
    runId: string,
    token: string,
  ): Promise<{
    submissionId: string;
    messageId: string;
    payload: Record<string, unknown>;
    remoteTaskId: string | null;
    remoteContextId: string | null;
  } | null>;
  recordRemoteTask(
    runId: string,
    token: string,
    task: {
      id: string;
      contextId?: string;
      state: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<boolean>;
  succeedWithLease(
    runId: string,
    token: string,
    result: Record<string, unknown>,
  ): Promise<AgentRun | null>;
  failWithLease(
    runId: string,
    token: string,
    error: string,
    errorCode?: string,
  ): Promise<AgentRun | null>;
  exhaustBudgetWithLease(
    runId: string,
    token: string,
    error: string,
    errorCode?: string,
  ): Promise<AgentRun | null>;
  cancelWithLease(
    runId: string,
    token: string,
    error?: string,
    errorCode?: string,
  ): Promise<AgentRun | null>;
  timeOutWithLease(
    runId: string,
    token: string,
    error?: string,
    errorCode?: string,
  ): Promise<AgentRun | null>;
  cancelQueued(
    runId: string,
    details?: { error?: string; errorCode?: string },
  ): Promise<AgentRun | null>;
  isCancellationRequested(runIds: readonly string[]): Promise<boolean>;
  prepareRemoteCancellation(runId: string): Promise<{
    userId: string;
    remoteAgentId: string;
    remoteTaskId: string;
    encryptedCredential: string | null;
  } | null>;
  recordRemoteCancellation(
    runId: string,
    outcome:
      | {
          ok: true;
          task: { id: string; state: string; contextId?: string };
          retryAt?: Date;
        }
      | { ok: false; error: string; retryAt: Date },
  ): Promise<AgentRun | null>;
};

export type DelegationWorkerEvent =
  | {
      kind: "started";
      child: AgentRun;
      parent: AgentRun;
      delegation: Delegation;
    }
  | {
      kind: "remote";
      child: AgentRun;
      eventType:
        | "agent.remote_task_created"
        | "agent.remote_status_changed"
        | "agent.remote_artifact_received"
        | "agent.remote_artifact_verified"
        | "agent.input_required"
        | "agent.auth_required";
      toStatus: string;
      payload?: Record<string, unknown>;
    }
  | { kind: "terminal"; child: AgentRun };

export type DelegationWorkerExecutorDependencies = {
  runs: RunManagerDependency;
  selectRun(id: string): Promise<AgentRun | null>;
  selectDelegation(childRunId: string): Promise<Delegation | null>;
  remote: RemoteService;
  executeLocal(input: {
    runId: string;
    userId: string;
    workspaceId?: string;
    taskId?: string;
    targetType: "agent";
    targetId: string;
    input: Record<string, unknown>;
    allowedTools: string[];
    timeoutMs: number;
    signal: AbortSignal;
    executionSource: "delegation";
    claimToken: string;
  }): Promise<AutomationExecutionResult>;
  enqueue(runId: string, delaySeconds?: number): Promise<boolean>;
  markDispatched(runId: string): Promise<void>;
  decryptCredential(value: string): string;
  recordEvent(event: DelegationWorkerEvent): Promise<void>;
  ingestRemoteArtifacts(
    claimed: unknown[],
    owner: { userId: string; runId: string },
  ): Promise<ArtifactReference[]>;
  pollMs?: number;
  now?: () => number;
  /** Test-only fault injection; omitted in production. */
  crashAt?: H10CrashPoint;
};

export type H10CrashPoint =
  | "after_claim"
  | "after_remote_submission_before_task_id"
  | "after_task_id"
  | "during_polling"
  | "after_waiting_persistence"
  | "after_child_terminal_before_event"
  | "after_artifact_persist_before_verification";

export class DelegationWorkerCrash extends Error {
  constructor(readonly point: H10CrashPoint) {
    super(`H10_CRASH:${point}`);
    this.name = "DelegationWorkerCrash";
  }
}

export function createDelegationWorkerExecutor(
  dependencies: DelegationWorkerExecutorDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const pollMs = dependencies.pollMs ?? 1_000;
  const crashAt = (point: H10CrashPoint) => {
    if (dependencies.crashAt === point) throw new DelegationWorkerCrash(point);
  };

  async function cancelRemote(childRunId: string) {
    const intent =
      await dependencies.runs.prepareRemoteCancellation(childRunId);
    if (!intent) return;
    const credential = intent.encryptedCredential
      ? (JSON.parse(
          dependencies.decryptCredential(intent.encryptedCredential),
        ) as RemoteAgentCredential)
      : undefined;
    try {
      const task = await dependencies.remote.cancelTask(
        intent.userId,
        intent.remoteAgentId,
        intent.remoteTaskId,
        credential,
      );
      const finished = await dependencies.runs.recordRemoteCancellation(
        childRunId,
        {
          ok: true,
          task,
          retryAt: new Date(now() + pollMs),
        },
      );
      if (finished)
        await dependencies.recordEvent({ kind: "terminal", child: finished });
    } catch (error) {
      await dependencies.runs.recordRemoteCancellation(childRunId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryAt: new Date(now() + pollMs),
      });
    }
  }

  const execute = async function execute(childRunId: string) {
    const child = await dependencies.selectRun(childRunId);
    if (child && isTerminalAgentRunStatus(child.status)) {
      // The durable event sink deduplicates this reconciliation on sweeper retries.
      await dependencies.recordEvent({ kind: "terminal", child });
      return;
    }
    if (child && !isActiveAgentRunStatus(child.status)) return;
    if (!child?.parentRunId) return;
    if (child.status === "waiting_external" && child.cancelRequestedAt) return;
    const delegation = await dependencies.selectDelegation(child.id);
    if (!delegation) return;
    if (delegation.targetKind === "local_agent" && !child.agentId) return;
    if (delegation.targetKind === "remote_agent" && !delegation.remoteAgentId) {
      const claimed = await dependencies.runs.claim(child.id);
      if (!claimed) return;
      const failed = await dependencies.runs.failWithLease(
        child.id,
        claimed.token,
        "Remote connection is no longer available",
        "REMOTE_AGENT_NOT_FOUND",
      );
      if (failed)
        await dependencies.recordEvent({ kind: "terminal", child: failed });
      return;
    }
    const parent = await dependencies.selectRun(child.parentRunId);
    if (
      !parent ||
      parent.cancelRequestedAt ||
      isTerminalAgentRunStatus(parent.status)
    ) {
      const cancelled = await dependencies.runs.cancelQueued(child.id, {
        errorCode: "PARENT_CANCELLED",
        error: "Parent cancelled",
      });
      if (cancelled)
        await dependencies.recordEvent({ kind: "terminal", child: cancelled });
      return;
    }
    const claimed = await dependencies.runs.claim(child.id);
    if (!claimed) {
      await dependencies.enqueue(child.id, 5);
      return;
    }
    const { run, token } = claimed;
    crashAt("after_claim");
    await dependencies.recordEvent({
      kind: "started",
      child,
      parent,
      delegation,
    });

    const controller = new AbortController();
    let abortCause: AbortCause;
    const abort = (cause: Exclude<AbortCause, undefined>) => {
      if (abortCause === "lease_lost") return;
      if (cause === "lease_lost" || !abortCause) abortCause = cause;
      controller.abort();
    };
    const deadline = run.absoluteDeadlineAt?.getTime() ?? now() + run.timeoutMs;
    const timeout = setTimeout(
      () => {
        abort("timeout");
      },
      Math.max(0, deadline - now()),
    );
    const poll = setInterval(() => {
      void dependencies.runs
        .heartbeat(run.id, token)
        .then((leaseState) => {
          if (leaseState !== "active")
            abort(leaseState === "timed_out" ? "timeout" : leaseState);
          if (leaseState === "lease_lost") return false;
          return Promise.all([
            dependencies.runs.isCancellationRequested([run.id, parent.id]),
            dependencies.selectRun(parent.id),
          ]).then(
            ([cancelled, currentParent]) =>
              cancelled ||
              !currentParent ||
              Boolean(currentParent.cancelRequestedAt) ||
              isTerminalAgentRunStatus(currentParent.status),
          );
        })
        .then((cancelled) => {
          if (cancelled) {
            abort("cancelled");
          }
        })
        .catch(() => undefined);
    }, pollMs);

    // Remote peers do not report trustworthy token usage. tokenBudget remains
    // orchestration metadata while root delegation/child accounting applies.
    const rawResult = await (delegation.targetKind === "remote_agent"
      ? executeRemote(
          run,
          delegation.remoteAgentId!,
          token,
          controller.signal,
          () => abortCause,
          () => abort("lease_lost"),
        )
      : dependencies.executeLocal({
          runId: run.id,
          userId: run.userId,
          workspaceId: run.workspaceId ?? undefined,
          taskId: run.taskId ?? undefined,
          targetType: "agent",
          targetId: run.agentId!,
          input: run.context,
          allowedTools: run.allowedTools,
          timeoutMs: Math.max(1, deadline - now()),
          signal: controller.signal,
          executionSource: "delegation",
          claimToken: token,
        })
    ).finally(() => {
      clearTimeout(timeout);
      clearInterval(poll);
    });
    if (abortCause === "lease_lost") return;
    if (!rawResult) return;
    const result = classifyAbortedExecution(rawResult, abortCause);
    if (
      result.status === "failed" &&
      result.errorCode === "REMOTE_INPUT_REQUIRED"
    ) {
      await dependencies.runs.waitForInput(run.id, token);
      return;
    }
    if (
      result.status === "failed" &&
      result.errorCode === "REMOTE_AUTH_REQUIRED"
    ) {
      await dependencies.runs.waitForApproval(run.id, token);
      return;
    }
    const finished =
      result.status === "succeeded"
        ? await dependencies.runs.succeedWithLease(run.id, token, result.output)
        : result.status === "timed_out"
          ? await dependencies.runs.timeOutWithLease(
              run.id,
              token,
              result.message,
              "TIMED_OUT",
            )
          : result.status === "cancelled"
            ? await dependencies.runs.cancelWithLease(
                run.id,
                token,
                result.message,
                "CANCELLED",
              )
            : result.status === "budget_exhausted"
              ? await dependencies.runs.exhaustBudgetWithLease(
                  run.id,
                  token,
                  result.message,
                )
              : await dependencies.runs.failWithLease(
                  run.id,
                  token,
                  result.message,
                  result.errorCode,
                );
    if (finished) crashAt("after_child_terminal_before_event");
    if (finished)
      await dependencies.recordEvent({ kind: "terminal", child: finished });
  };

  async function executeRemote(
    child: AgentRun,
    remoteAgentId: string,
    token: string,
    signal: AbortSignal,
    abortCause: () => AbortCause,
    leaseLost: () => void,
  ): Promise<AutomationExecutionResult | null> {
    let remoteTaskId: string | undefined;
    let credential: RemoteAgentCredential | undefined;
    try {
      const continuation = await dependencies.runs.consumeContinuation(
        child.id,
        token,
      );
      const intent = await dependencies.runs.prepareRemoteSubmission(
        child.id,
        token,
      );
      if (!intent) {
        leaseLost();
        throw new Error("REMOTE_SUBMISSION_LEASE_LOST");
      }
      const encryptedCredential =
        await dependencies.runs.selectTransientCredential(child.id, token);
      credential = encryptedCredential
        ? (JSON.parse(
            dependencies.decryptCredential(encryptedCredential),
          ) as RemoteAgentCredential)
        : undefined;
      const sendResult = continuation
        ? await dependencies.remote.continueTask(
            child.userId,
            remoteAgentId,
            {
              id: intent.remoteTaskId ?? undefined,
              contextId: intent.remoteContextId ?? undefined,
              message: {
                role: "user",
                messageId: continuation.messageId,
                parts: [
                  {
                    kind: "text",
                    text:
                      continuation.kind === "input"
                        ? String(continuation.payload.message ?? "Continue")
                        : "Authentication supplied. Continue the task.",
                  },
                ],
              },
              metadata: {
                runId: child.id,
                submissionId: continuation.submissionId,
              },
            },
            { requestId: continuation.submissionId!, credential },
          )
        : intent.remoteTaskId
          ? await dependencies.remote.getTask(
              child.userId,
              remoteAgentId,
              intent.remoteTaskId,
              credential,
            )
          : await dependencies.remote.sendTask(
              child.userId,
              remoteAgentId,
              intent.payload,
              {
                requestId: intent.submissionId,
              },
            );
      crashAt("after_remote_submission_before_task_id");
      const task: A2ATask =
        "kind" in sendResult
          ? {
              id: intent.remoteTaskId ?? `message:${intent.submissionId}`,
              state: "completed",
              statusMessage: sendResult.message,
              raw: sendResult.message,
            }
          : sendResult;
      if (intent.remoteTaskId) crashAt("during_polling");
      remoteTaskId = task.id;
      if (continuation?.submissionId) {
        const consumed = await dependencies.runs.consumeContinuationMessage(
          child.id,
          token,
          continuation.submissionId,
        );
        if (!consumed) {
          leaseLost();
          throw new Error("REMOTE_CONTINUATION_LEASE_LOST");
        }
      }
      if (signal.aborted) throw new Error("RUN_ABORTED");
      const metadata = remoteTaskMetadata(task);
      if (["submitted", "working"].includes(task.state)) {
        const waiting = await dependencies.runs.deferRemoteTask(
          child.id,
          token,
          { ...task, metadata },
          "REMOTE_WORKING",
          new Date(now() + pollMs),
        );
        if (!waiting) {
          leaseLost();
          throw new Error("REMOTE_SUBMISSION_LEASE_LOST");
        }
        crashAt("after_waiting_persistence");
        await dependencies.recordEvent({
          kind: "remote",
          child: waiting,
          eventType: intent.remoteTaskId
            ? "agent.remote_status_changed"
            : "agent.remote_task_created",
          toStatus: task.state,
          payload: metadata,
        });
        try {
          const enqueued = await dependencies.enqueue(
            child.id,
            Math.max(1, Math.ceil(pollMs / 1_000)),
          );
          if (enqueued) await dependencies.markDispatched(child.id);
        } catch {
          // The durable dispatch remains pending for the sweeper.
        }
        return null;
      }
      if (
        !(await dependencies.runs.recordRemoteTask(child.id, token, {
          ...task,
          metadata,
        }))
      ) {
        leaseLost();
        throw new Error("REMOTE_SUBMISSION_LEASE_LOST");
      }
      crashAt("after_task_id");
      await dependencies.recordEvent({
        kind: "remote",
        child,
        eventType: "agent.remote_task_created",
        toStatus: task.state,
        payload: metadata,
      });
      if (["input_required", "auth_required"].includes(task.state)) {
        await dependencies.recordEvent({
          kind: "remote",
          child,
          eventType:
            task.state === "input_required"
              ? "agent.input_required"
              : task.state === "auth_required"
                ? "agent.auth_required"
                : "agent.remote_status_changed",
          toStatus: task.state,
          payload: metadata,
        });
      }
      if (task.state === "completed") {
        let artifacts: ArtifactReference[] = [];
        if (task.artifacts?.length) {
          await dependencies.recordEvent({
            kind: "remote",
            child,
            eventType: "agent.remote_artifact_received",
            toStatus: task.state,
            payload: { artifactCount: task.artifacts.length },
          });
          try {
            artifacts = await dependencies.ingestRemoteArtifacts(
              task.artifacts,
              {
                userId: child.userId,
                runId: child.id,
              },
            );
            crashAt("after_artifact_persist_before_verification");
          } catch (error) {
            if (error instanceof DelegationWorkerCrash) throw error;
            return {
              status: "failed",
              errorCode: "VERIFICATION_FAILED",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            };
          }
          await dependencies.recordEvent({
            kind: "remote",
            child,
            eventType: "agent.remote_artifact_verified",
            toStatus: task.state,
            payload: { artifactCount: artifacts.length },
          });
        }
        return {
          status: "succeeded",
          output: {
            remoteTaskId: task.id,
            remoteContextId: task.contextId,
            artifacts,
            statusMessage: metadata.statusMessage,
          },
        };
      }
      if (task.state === "cancelled")
        return { status: "cancelled", message: "Remote task cancelled" };
      return {
        status: "failed",
        errorCode:
          task.state === "input_required"
            ? "REMOTE_INPUT_REQUIRED"
            : task.state === "auth_required"
              ? "REMOTE_AUTH_REQUIRED"
              : task.state === "rejected"
                ? "REMOTE_REJECTED"
                : "REMOTE_FAILED",
        message: `Remote task ended in ${task.state}`,
        retryable: task.state === "unknown",
      };
    } catch (error) {
      if (error instanceof DelegationWorkerCrash) throw error;
      if (signal.aborted) {
        if (remoteTaskId && abortCause() === "cancelled") return null;
        if (remoteTaskId && abortCause() !== "lease_lost")
          await dependencies.remote
            .cancelTask(child.userId, remoteAgentId, remoteTaskId, credential)
            .catch(() => undefined);
        return classifyAbortedExecution(
          { status: "cancelled" as const, message: "Run was cancelled" },
          abortCause(),
        );
      }
      return {
        status: "failed",
        errorCode: "REMOTE_EXECUTION_ERROR",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  return Object.assign(execute, { cancelRemote });
}

function remoteTaskMetadata(task: A2ATask): Record<string, unknown> {
  const waiting = ["input_required", "auth_required"].includes(task.state);
  return sanitizeActivityPayload({
    ...(task.statusMessage !== undefined
      ? { statusMessage: task.statusMessage }
      : {}),
    ...(waiting && task.statusMessage !== undefined
      ? { waitingRequest: task.statusMessage }
      : {}),
  }) as Record<string, unknown>;
}
