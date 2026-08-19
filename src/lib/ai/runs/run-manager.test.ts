import { describe, expect, test, vi } from "vitest";
import type { AgentRunRepository } from "./agent-run-repository";
import { RunManager } from "./run-manager";

vi.mock("server-only", () => ({}));

function repository() {
  return {
    createRunning: vi.fn(),
    createDelegated: vi.fn(),
    selectById: vi.fn(),
    claimQueued: vi.fn(),
    heartbeat: vi.fn(),
    finishRunning: vi.fn(),
    wait: vi.fn(),
    resume: vi.fn(),
    consumeContinuation: vi.fn(),
    consumeContinuationMessage: vi.fn(),
    selectTransientCredential: vi.fn(),
    prepareRemoteSubmission: vi.fn(),
    recordRemoteTask: vi.fn(),
    deferRemoteTask: vi.fn(),
    cancelQueued: vi.fn(),
    requestCancellationTree: vi.fn(),
    prepareRemoteCancellation: vi.fn(),
    recordRemoteCancellation: vi.fn(),
    isCancellationRequested: vi.fn(),
    countRunningChildren: vi.fn(),
    listStaleDelegatedRunIds: vi.fn(),
    listPendingDispatchRunIds: vi.fn(),
    markDispatched: vi.fn(),
    listPendingRemoteCancellationRunIds: vi.fn(),
    markRemoteCancellationDispatched: vi.fn(),
    suspendParent: vi.fn(),
    claimParentResume: vi.fn(),
    checkpointParentAgain: vi.fn(),
    finishParentResume: vi.fn(),
    listPendingParentResumeIds: vi.fn(),
    markParentResumeDispatched: vi.fn(),
  } satisfies AgentRunRepository;
}

describe("RunManager", () => {
  test("maps semantic terminal commands to immutable running transitions", async () => {
    const runs = repository();
    const manager = new RunManager(runs);
    const result = { reportId: "report-1" };

    await manager.succeedWithLease("run-1", "lease-1", result);
    await manager.failWithLease(
      "run-2",
      "lease-2",
      "provider failed",
      "PROVIDER_FAILED",
    );
    await manager.cancelWithLease(
      "run-3",
      "lease-3",
      "user cancelled",
      "CANCELLED",
    );
    await manager.timeOutWithLease(
      "run-4",
      "lease-4",
      "deadline exceeded",
      "TIMED_OUT",
    );

    expect(runs.finishRunning.mock.calls).toEqual([
      ["run-1", "lease-1", { status: "succeeded", result }],
      [
        "run-2",
        "lease-2",
        {
          status: "failed",
          error: "provider failed",
          errorCode: "PROVIDER_FAILED",
        },
      ],
      [
        "run-3",
        "lease-3",
        {
          status: "cancelled",
          error: "user cancelled",
          errorCode: "CANCELLED",
        },
      ],
      [
        "run-4",
        "lease-4",
        {
          status: "timed_out",
          error: "deadline exceeded",
          errorCode: "TIMED_OUT",
        },
      ],
    ]);
  });

  test("passes lease tokens through heartbeats, waits, and continuation", async () => {
    const runs = repository();
    const manager = new RunManager(runs);
    await manager.heartbeat("run-1", "lease-1", 5_000);
    await manager.waitForInput("run-1", "lease-1");
    await manager.consumeContinuation("run-1", "lease-1");
    const task = {
      id: "remote-1",
      state: "working",
      metadata: { statusMessage: "Still working" },
    };
    await manager.deferRemoteTask("run-1", "lease-1", task);

    expect(runs.heartbeat).toHaveBeenCalledWith("run-1", "lease-1", 5_000);
    expect(runs.wait).toHaveBeenCalledWith(
      "run-1",
      "waiting_input",
      "REMOTE_INPUT_REQUIRED",
      "lease-1",
    );
    expect(runs.consumeContinuation).toHaveBeenCalledWith("run-1", "lease-1");
    expect(runs.deferRemoteTask).toHaveBeenCalledWith(
      "run-1",
      "lease-1",
      "REMOTE_WORKING",
      task,
      expect.any(Date),
    );
  });

  test("keeps queued cancellation distinct from cooperative cancellation", async () => {
    const runs = repository();
    const manager = new RunManager(runs);

    await manager.cancelQueued("child-1", {
      errorCode: "PARENT_CANCELLED",
      error: "Parent cancelled",
    });
    await manager.requestCancellation("root-1", "user-1");

    expect(runs.cancelQueued).toHaveBeenCalledWith("child-1", {
      errorCode: "PARENT_CANCELLED",
      error: "Parent cancelled",
    });
    expect(runs.requestCancellationTree).toHaveBeenCalledWith(
      "root-1",
      "user-1",
    );
  });
});
