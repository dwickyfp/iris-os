import type { ActivityEventInput } from "app-types/activity";
import { hasArtifactClaims } from "../artifacts";
import type { RunManager } from "../runs/run-manager";
import type { RunLeaseState, RunOutcome } from "../runs/types";
import { isTerminalAgentRunStatus } from "../runs/status";
import type {
  HarnessEventRecorder,
  HarnessFailure,
  HarnessFinalization,
  HarnessOrchestration,
  HarnessStreamResult,
} from "./contracts";
import type {
  DriverGenerateInput,
  DriverStreamInput,
  ExecutionDriver,
} from "./execution-driver";
import type { CompletionRequirement, VerificationResult } from "./verification";
import { isBudgetExhausted } from "./budget";

const FOREGROUND_LEASE_MS = 30_000;
const FOREGROUND_HEARTBEAT_MS = 10_000;

type ExecutionLease = {
  token: string;
  signal?: AbortSignal;
  state(): RunLeaseState;
  assertActive(): void;
  stop(): void;
};

function leaseLost(): Error {
  return new Error("LEASE_LOST");
}

function isLeaseLost(error: unknown) {
  return error instanceof Error && error.message === "LEASE_LOST";
}

function stoppedError(state: Exclude<RunLeaseState, "active">): Error {
  if (state === "lease_lost") return leaseLost();
  return new Error(state === "cancelled" ? "CANCELLED" : "TIMED_OUT");
}

function budgetStoppedError(): Error {
  return new Error("BUDGET_EXHAUSTED");
}

function terminalStatus(
  status: unknown,
  fallback: RunOutcome["status"],
): RunOutcome["status"] {
  if (
    typeof status === "string" &&
    isTerminalAgentRunStatus(status as RunOutcome["status"])
  )
    return status as RunOutcome["status"];
  return fallback;
}

export class IrisHarness {
  constructor(
    private readonly driver: ExecutionDriver,
    private readonly runs?: RunManager,
    private readonly completionRequirements: readonly CompletionRequirement[] = [],
    private readonly recorder?: HarnessEventRecorder,
  ) {}

  async stream(
    input: DriverStreamInput,
  ): Promise<
    HarnessStreamResult<Awaited<ReturnType<ExecutionDriver["stream"]>>>
  > {
    this.assertOrchestration(input.orchestration);
    let lease: ExecutionLease | undefined;
    try {
      await this.recordRouting(input.orchestration);
      lease = await this.start(input.orchestration);
      const native = await this.driver.stream(
        this.withEventRecording(input, input.orchestration),
      );
      return this.lifecycle(native, input.orchestration, lease);
    } catch (error) {
      try {
        await this.fail(input.orchestration, { error }, lease);
      } finally {
        lease?.stop();
      }
      throw error;
    }
  }

  /**
   * Generates, verifies, and finalizes an execution while returning the exact
   * native driver result for migration compatibility.
   */
  async generate(input: DriverGenerateInput) {
    this.assertOrchestration(input.orchestration);
    let lease: ExecutionLease | undefined;
    try {
      await this.recordRouting(input.orchestration);
      lease = await this.start(input.orchestration);
      const native = await this.driver.generate(
        this.withEventRecording(input, input.orchestration),
      );
      await this.finalize(input.orchestration, native, {}, lease);
      return native;
    } catch (error) {
      if (!isLeaseLost(error)) {
        await this.fail(input.orchestration, { error }, lease);
      }
      throw error;
    } finally {
      lease?.stop();
    }
  }

  async generateClaimed(input: DriverGenerateInput) {
    this.assertOrchestration(input.orchestration);
    if (input.orchestration.run.mode !== "claimed" || !this.runs)
      throw new Error("CLAIMED_RUN_ORCHESTRATION_REQUIRED");
    const claimToken = input.orchestration.run.claimToken;
    const runId = input.orchestration.identity.runId;
    const orchestration = input.orchestration;
    const controller = new AbortController();
    const callerSignal = input.execution.abortSignal;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const lease = this.heartbeat(runId, claimToken, controller, () =>
      callerSignal?.removeEventListener("abort", abortFromCaller),
    );
    let native;
    try {
      await this.recordRouting(orchestration);
      native = await this.driver.generate({
        ...this.withEventRecording(input, orchestration),
        execution: {
          ...input.execution,
          abortSignal: controller.signal,
        },
      });
      lease.assertActive();
    } catch (error) {
      lease.stop();
      if (lease.state() === "lease_lost" || isLeaseLost(error))
        throw leaseLost();
      await this.finishClaimedFailure(
        orchestration,
        claimToken,
        error,
        lease.state(),
      );
      throw error;
    }
    let terminal: Promise<unknown> | undefined;
    return {
      native,
      signal: lease.signal!,
      assertActive: () => lease.assertActive(),
      finalize: (result: Record<string, unknown>, value: unknown = native) => {
        if (!terminal) {
          let finished = false;
          terminal = Promise.resolve()
            .then(() => lease.assertActive())
            .then(() => this.verify(value, orchestration))
            .then(async (verification) => {
              lease.assertActive();
              const run = await this.runs!.finishParentResume(
                runId,
                claimToken,
                { status: "succeeded", result },
              );
              if (!run) throw leaseLost();
              finished = true;
              const status = terminalStatus(run.status, "succeeded");
              await this.recordClaimedTerminal(orchestration, status);
              if (status !== "succeeded") {
                throw status === "failed"
                  ? new Error("PARENT_RESUME_FAILED")
                  : status === "budget_exhausted"
                    ? budgetStoppedError()
                    : stoppedError(status);
              }
              return { run, verification };
            })
            .catch(async (error) => {
              if (finished || isLeaseLost(error)) throw error;
              await this.finishClaimedFailure(
                orchestration,
                claimToken,
                error,
                lease.state(),
              );
              throw error;
            })
            .finally(() => lease.stop());
        }
        return terminal;
      },
      fail: async (error: unknown, errorCode = "PARENT_RESUME_FAILED") => {
        try {
          return await this.finishClaimedFailure(
            orchestration,
            claimToken,
            error,
            lease.state(),
            errorCode,
          );
        } finally {
          lease.stop();
        }
      },
      waitForExternal: async (
        checkpoint: Parameters<RunManager["checkpointParentAgain"]>[2],
      ) => {
        lease.assertActive();
        const run = await this.runs!.checkpointParentAgain(
          runId,
          claimToken,
          checkpoint,
        );
        if (!run) {
          await this.finishClaimedFailure(
            orchestration,
            claimToken,
            new Error("PARENT_SUSPENSION_REJECTED"),
            lease.state(),
            "PARENT_SUSPENSION_REJECTED",
          );
          throw new Error("PARENT_SUSPENSION_REJECTED");
        }
        lease.stop();
        if (run.status !== "waiting_external") {
          const status = terminalStatus(run.status, "failed");
          await this.recordClaimedTerminal(orchestration, status);
          throw status === "cancelled" || status === "timed_out"
            ? stoppedError(status)
            : new Error("PARENT_SUSPENSION_REJECTED");
        }
        await this.record(orchestration, "trajectory.step_completed", {
          toStatus: "waiting_external",
          waitingReason: "DELEGATED_CHILDREN",
        });
        return run;
      },
    };
  }

  cancel(runId: string, userId: string) {
    if (!this.runs) throw new Error("RUN_MANAGER_NOT_CONFIGURED");
    return this.runs.requestCancellation(runId, userId);
  }

  private lifecycle<Native>(
    native: Native,
    orchestration: HarnessOrchestration,
    lease?: ExecutionLease,
  ): HarnessStreamResult<Native> {
    let terminal: Promise<HarnessFinalization> | undefined;
    return {
      native,
      finalize: (value, result) => {
        if (!terminal) {
          terminal = this.finalize(orchestration, value, result, lease)
            .catch(async (error) => {
              if (!isLeaseLost(error)) {
                await this.fail(orchestration, { error }, lease);
              }
              throw error;
            })
            .finally(() => lease?.stop());
        }
        return terminal;
      },
      fail: async (failure) => {
        if (!terminal) {
          terminal = this.fail(orchestration, failure, lease)
            .then(() => ({}))
            .finally(() => lease?.stop());
        }
        await terminal;
      },
      waitForExternal: async (checkpoint) => {
        if (!terminal) {
          terminal = this.waitForExternal(orchestration, checkpoint, lease)
            .then(() => ({}))
            .finally(() => lease?.stop());
        }
        await terminal;
      },
    };
  }

  private async start(
    orchestration: HarnessOrchestration,
  ): Promise<ExecutionLease | undefined> {
    const { identity, run, context, policy } = orchestration;
    let lease: ExecutionLease | undefined;
    if (run.mode === "create") {
      if (!this.runs) throw new Error("RUN_MANAGER_NOT_CONFIGURED");
      const started = await this.runs.start({
        ...run.spec,
        id: identity.runId,
        userId: identity.userId,
        agentId: run.spec.agentId ?? identity.agentId,
        parentRunId: run.spec.parentRunId ?? identity.parentRunId,
        workspaceId: run.spec.workspaceId ?? identity.workspaceId,
        taskId: run.spec.taskId ?? identity.taskId,
        context: {
          ...run.spec.context,
          requestId: identity.requestId,
          threadId: identity.threadId,
          contextProvenance: context?.provenance,
          contextDiagnostics: context?.diagnostics,
          resolvedPolicy: policy,
          budget: orchestration.budget,
        },
      });
      if (!started.leaseToken) throw leaseLost();
      lease = this.heartbeat(identity.runId, started.leaseToken);
    }
    if (run.mode === "create") {
      await this.record(orchestration, "trajectory.started", {
        toStatus: "running",
      });
      await this.record(orchestration, "run.started", { toStatus: "running" });
    }
    if (context) {
      await this.record(orchestration, "context.prepared", {
        ...context.diagnostics,
        sourceCount: context.provenance.length,
        provenance: context.provenance,
      });
    }
    return lease;
  }

  private assertOrchestration(
    orchestration: HarnessOrchestration | undefined,
  ): asserts orchestration is HarnessOrchestration {
    if (!orchestration?.identity || !orchestration.run)
      throw new Error("HARNESS_ORCHESTRATION_REQUIRED");
    if (
      !orchestration.identity.userId ||
      !orchestration.identity.runId ||
      !orchestration.identity.requestId
    )
      throw new Error("HARNESS_IDENTITY_REQUIRED");
    if (orchestration.run.mode === "claimed" && !orchestration.run.claimToken)
      throw new Error("CLAIM_TOKEN_REQUIRED");
  }

  private heartbeat(
    runId: string,
    token: string,
    controller?: AbortController,
    cleanup?: () => void,
  ): ExecutionLease {
    let stopped = false;
    let state: "active" | "cancelled" | "timed_out" | "lease_lost" = "active";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        try {
          const heartbeatState = await this.runs?.heartbeat(
            runId,
            token,
            FOREGROUND_LEASE_MS,
          );
          if (heartbeatState && heartbeatState !== "active") {
            state = heartbeatState;
            stopped = true;
            controller?.abort(stoppedError(heartbeatState));
            return;
          }
        } catch {
          // A transient heartbeat error is retried while the current lease lives.
        }
        if (!stopped) schedule();
      }, FOREGROUND_HEARTBEAT_MS);
      timer.unref?.();
    };
    schedule();
    return {
      token,
      signal: controller?.signal,
      state: () => state,
      assertActive() {
        if (state !== "active") throw stoppedError(state);
        controller?.signal.throwIfAborted();
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        cleanup?.();
      },
    };
  }

  private async finishClaimedFailure(
    orchestration: HarnessOrchestration,
    claimToken: string,
    error: unknown,
    leaseState: RunLeaseState,
    failureCode = "PARENT_RESUME_FAILED",
  ) {
    if (leaseState === "lease_lost") throw leaseLost();
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = isBudgetExhausted(error);
    const outcome: RunOutcome =
      exhausted
        ? {
            status: "budget_exhausted",
            error: message,
            errorCode: "BUDGET_EXHAUSTED",
          }
        : leaseState === "cancelled"
        ? { status: "cancelled", error: message, errorCode: "CANCELLED" }
        : leaseState === "timed_out"
          ? { status: "timed_out", error: message, errorCode: "TIMED_OUT" }
          : {
              status: "failed",
              error: message,
              errorCode: failureCode,
            };
    const run = await this.runs!.finishParentResume(
      orchestration.identity.runId,
      claimToken,
      outcome,
    );
    if (!run) throw leaseLost();
    const status = terminalStatus(run.status, outcome.status);
    await this.recordClaimedTerminal(
      orchestration,
      status,
      status === "failed" || status === "budget_exhausted"
        ? outcome.errorCode
        : undefined,
    );
    return run;
  }

  private async recordClaimedTerminal(
    orchestration: HarnessOrchestration,
    status: RunOutcome["status"],
    errorCode?: string,
  ) {
    if (status === "succeeded") {
      await this.record(orchestration, "trajectory.completed", {
        toStatus: status,
      });
      await this.record(orchestration, "run.completed", { toStatus: status });
      return;
    }
    await this.record(
      orchestration,
      status === "cancelled" ? "trajectory.cancelled" : "trajectory.failed",
      {
        toStatus: status,
        errorCode:
          status === "cancelled"
            ? "CANCELLED"
            : status === "timed_out"
              ? "TIMED_OUT"
               : status === "budget_exhausted"
                 ? "BUDGET_EXHAUSTED"
                 : errorCode,
      },
    );
    await this.record(
      orchestration,
      status === "cancelled"
        ? "run.cancelled"
        : status === "budget_exhausted"
          ? "run.budget_exhausted"
          : "run.failed",
       {
         toStatus: status,
         errorCode:
           status === "budget_exhausted" ? "BUDGET_EXHAUSTED" : errorCode,
       },
    );
  }

  private async finalize(
    orchestration: HarnessOrchestration,
    value: unknown,
    result: Record<string, unknown> = {},
    lease?: ExecutionLease,
  ): Promise<HarnessFinalization> {
    const verification = await this.verify(value, orchestration);
    if (orchestration.run.mode === "create") {
      if (!lease) throw leaseLost();
      lease.assertActive();
      const run = await this.runs?.succeedWithLease(
        orchestration.identity.runId,
        lease.token,
        result,
      );
      if (!run) throw leaseLost();
    }
    if (orchestration.run.mode === "create") {
      await this.record(orchestration, "trajectory.completed", {
        toStatus: "succeeded",
      });
      await this.record(orchestration, "run.completed", {
        toStatus: "succeeded",
      });
    }
    return { result, verification };
  }

  private async verify(
    value: unknown,
    orchestration: HarnessOrchestration,
  ): Promise<VerificationResult[]> {
    const requirements = await this.requirementsFor(
      value,
      orchestration.completionRequirement,
    );
    const verification: VerificationResult[] = [];
    await this.record(orchestration, "verification.started", {
      verified: false,
      requirementCount: requirements.length,
      toStatus: "running",
    });
    for (const requirement of requirements) {
      const outcome = await requirement.verifyCompletion(value, {
        userId: orchestration.identity.userId,
        runId: orchestration.identity.runId,
      });
      verification.push(outcome);
      if (!outcome.verified) {
        await this.record(orchestration, "verification.failed", {
          verified: false,
          reason: outcome.reason,
          requirementCount: requirements.length,
          check: outcome,
          checkIndex: verification.length - 1,
          toStatus: "failed",
        });
        throw new Error(`VERIFICATION_REQUIRED:${outcome.reason}`);
      }
    }
    await this.record(orchestration, "verification.completed", {
      verified: true,
      requirementCount: requirements.length,
      checks: verification,
      toStatus: "succeeded",
    });
    return verification;
  }

  private async fail(
    orchestration: HarnessOrchestration,
    raw: HarnessFailure | unknown,
    lease?: ExecutionLease,
  ) {
    const failure: HarnessFailure =
      raw && typeof raw === "object" && "error" in raw
        ? (raw as HarnessFailure)
        : { error: raw };
    const message =
      failure.error instanceof Error
        ? failure.error.message
        : String(failure.error);
    const exhausted = isBudgetExhausted(failure.error);
    const status = exhausted
      ? "budget_exhausted"
      : (failure.status ?? "failed");
    const errorCode = exhausted ? "BUDGET_EXHAUSTED" : failure.errorCode;
    if (orchestration.run.mode === "create") {
      if (!lease) throw leaseLost();
      lease.assertActive();
      let run;
      if (status === "cancelled") {
        run = await this.runs?.cancelWithLease(
          orchestration.identity.runId,
          lease.token,
          message.slice(0, 2_000),
          errorCode,
        );
      } else if (status === "timed_out") {
        run = await this.runs?.timeOutWithLease(
          orchestration.identity.runId,
          lease.token,
          message.slice(0, 2_000),
          errorCode,
        );
      } else if (status === "budget_exhausted") {
        run = await this.runs?.exhaustBudgetWithLease(
          orchestration.identity.runId,
          lease.token,
          message.slice(0, 2_000),
          errorCode,
        );
      } else {
        run = await this.runs?.failWithLease(
          orchestration.identity.runId,
          lease.token,
          message.slice(0, 2_000),
          errorCode,
        );
      }
      if (!run) throw leaseLost();
    }
    if (orchestration.run.mode === "create") {
      await this.record(
        orchestration,
        status === "cancelled" ? "trajectory.cancelled" : "trajectory.failed",
        {
          toStatus: status,
          errorCode,
          message: message.slice(0, 2_000),
        },
      );
      await this.record(
        orchestration,
        status === "cancelled"
          ? "run.cancelled"
          : status === "budget_exhausted"
            ? "run.budget_exhausted"
            : "run.failed",
        {
          toStatus: status,
          errorCode,
          message: message.slice(0, 2_000),
        },
      );
    }
  }

  private async waitForExternal(
    orchestration: HarnessOrchestration,
    checkpoint: Parameters<RunManager["suspendParent"]>[2],
    lease?: ExecutionLease,
  ) {
    if (orchestration.run.mode !== "create" || !this.runs || !lease)
      throw leaseLost();
    lease.assertActive();
    const run = await this.runs.suspendParent(
      orchestration.identity.runId,
      lease.token,
      checkpoint,
    );
    if (!run) {
      const failed = await this.runs.failWithLease(
        orchestration.identity.runId,
        lease.token,
        "Parent suspension was rejected because no matching delegation join exists",
        "PARENT_SUSPENSION_REJECTED",
      );
      if (!failed) throw leaseLost();
      await this.record(orchestration, "trajectory.failed", {
        toStatus: "failed",
        errorCode: "PARENT_SUSPENSION_REJECTED",
      });
      throw new Error("PARENT_SUSPENSION_REJECTED");
    }
    const status = terminalStatus(run.status, "failed");
    if (run.status !== "waiting_external") {
      await this.recordClaimedTerminal(orchestration, status);
      throw status === "cancelled" || status === "timed_out"
        ? stoppedError(status)
        : new Error("PARENT_SUSPENSION_REJECTED");
    }
    await this.record(orchestration, "trajectory.step_completed", {
      toStatus: "waiting_external",
      waitingReason: "DELEGATED_CHILDREN",
    });
  }

  private async requirementsFor(
    value: unknown,
    requirement?: CompletionRequirement,
  ) {
    if (requirement) return [requirement];
    if (this.completionRequirements.length) return this.completionRequirements;
    if (!hasArtifactClaims(value)) return [];
    return [
      (
        await import("../artifacts/default-verification.server")
      ).createDefaultArtifactVerificationRequirement(),
    ];
  }

  private async record(
    orchestration: HarnessOrchestration,
    eventType: ActivityEventInput["eventType"],
    payload: Record<string, unknown>,
  ) {
    if (!this.recorder) return;
    const { identity } = orchestration;
    const scopeType = identity.taskId
      ? "task"
      : identity.workspaceId
        ? "workspace"
        : identity.agentId
          ? "agent"
          : "global";
    await this.recorder.recordRuntime(identity.userId, {
      actorType: identity.actorType ?? "system",
      actorId: identity.actorId ?? identity.agentId,
      scopeType,
      scopeId:
        identity.taskId ?? identity.workspaceId ?? identity.agentId ?? null,
      eventType,
      subjectType: "agent_run",
      subjectId: identity.runId,
      payload,
      requestId: identity.requestId,
      runId: identity.runId,
      parentRunId: identity.parentRunId,
      threadId: identity.threadId,
      taskId: identity.taskId,
      agentId: identity.agentId,
    });
  }

  private recordRouting(orchestration: HarnessOrchestration) {
    const routing = orchestration.routing;
    return this.record(orchestration, "routing.resolved", {
      descriptorIds: routing?.descriptorIds ?? [],
      diagnostics: routing?.diagnostics ?? {},
      ...(routing?.model ?? {}),
      ...(routing?.driver ?? { driver: this.driver.id }),
    });
  }

  private withEventRecording<T extends DriverGenerateInput | DriverStreamInput>(
    input: T,
    orchestration?: HarnessOrchestration,
  ): T {
    if (!orchestration || !this.recorder) return input;
    return {
      ...input,
      agent: {
        ...input.agent,
        onRuntimeEvent: async (eventType, payload) => {
          await input.agent.onRuntimeEvent?.(eventType, payload);
          await this.record(orchestration, eventType, payload);
        },
      },
    };
  }
}
