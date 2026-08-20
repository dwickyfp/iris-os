import { describe, expect, test, vi } from "vitest";
import { H10_HARNESS_POINTS } from "../../delegation/h10-recovery-matrix";
import type { HarnessOrchestration } from "./contracts";
import { IrisHarness } from "./harness";

function orchestration(
  overrides: Partial<HarnessOrchestration> = {},
): HarnessOrchestration {
  return {
    identity: {
      userId: "user-1",
      runId: "run-1",
      requestId: "request-1",
      threadId: crypto.randomUUID(),
    },
    run: { mode: "create", spec: { allowedTools: ["search"] } },
    ...overrides,
  };
}

function dependencies() {
  return {
    runs: {
      start: vi.fn(async () => ({ id: "run-1", leaseToken: "lease-1" })),
      heartbeat: vi.fn(async () => "active" as const),
      succeedWithLease: vi.fn(async () => ({ id: "run-1" })),
      failWithLease: vi.fn(async () => ({ id: "run-1" })),
      cancelWithLease: vi.fn(async () => ({ id: "run-1" })),
      timeOutWithLease: vi.fn(async () => ({ id: "run-1" })),
      requestCancellation: vi.fn(),
      suspendParent: vi.fn(async () => ({
        id: "run-1",
        status: "waiting_external",
      })),
      finishParentResume: vi.fn(async () => ({ id: "run-1" })),
      checkpointParentAgain: vi.fn(async () => ({ id: "run-1" })),
    },
    recorder: {
      record: vi.fn(async () => ({})),
      recordRuntime: vi.fn(async () => ({})),
    },
  };
}

describe("IrisHarness", () => {
  test.each(H10_HARNESS_POINTS)("H10 recovery seam: %s", async (point) => {
    const { runs } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(async () => ({ text: "complete" })),
        stream: vi.fn(),
      } as never,
      runs as never,
    );
    const generated = await harness.generateClaimed({
      agent: {},
      execution: {},
      orchestration: orchestration({
        run: { mode: "claimed", claimToken: "claim-1" },
      }),
    } as never);

    await generated.finalize({ text: "complete" });
    await generated.finalize({ text: "duplicate" });

    expect(runs.finishParentResume).toHaveBeenCalledOnce();
    expect(runs.finishParentResume).toHaveBeenCalledWith(
      "run-1",
      "claim-1",
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(point).toMatch(/parent_observation|verification/);
  });

  test("preserves the exact native stream and owns start/finalization", async () => {
    const native = { consumeStream: vi.fn(), toUIMessageStream: vi.fn() };
    const driver = {
      id: "test",
      generate: vi.fn(),
      stream: vi.fn(async () => native),
    };
    const { runs, recorder } = dependencies();
    const harness = new IrisHarness(
      driver as never,
      runs as never,
      [],
      recorder,
    );
    const spec = orchestration({
      context: {
        provenance: [{ source: "conversation", messageIds: ["message-1"] }],
        diagnostics: {
          compacted: false,
          estimatedTokensBefore: 10,
          estimatedTokensAfter: 10,
          budget: 100,
          retainedMessages: 1,
          summarizedMessages: 0,
        },
      },
    });

    const stream = await harness.stream({
      agent: {},
      execution: { messages: [] },
      orchestration: spec,
    } as never);

    expect(stream.native).toBe(native);
    expect(runs.start).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "run-1",
        userId: "user-1",
        context: expect.objectContaining({
          requestId: "request-1",
          contextProvenance: spec.context?.provenance,
        }),
      }),
    );
    const first = stream.finalize({ text: "complete" }, { messageId: "m-1" });
    const second = stream.finalize({ text: "ignored" });
    await expect(first).resolves.toMatchObject({ verification: [] });
    await expect(second).resolves.toMatchObject({ verification: [] });
    expect(runs.succeedWithLease).toHaveBeenCalledOnce();
    expect(runs.succeedWithLease).toHaveBeenCalledWith("run-1", "lease-1", {
      messageId: "m-1",
    });
    expect(runs.failWithLease).not.toHaveBeenCalled();
    expect(
      recorder.recordRuntime.mock.calls.map((call: any[]) => call[1].eventType),
    ).toEqual([
      "trajectory.started",
      "run.started",
      "context.prepared",
      "routing.resolved",
      "verification.started",
      "verification.completed",
      "trajectory.completed",
      "run.completed",
    ]);
  });

  test("fails idempotently and never succeeds after failure", async () => {
    const { runs, recorder } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(),
        stream: vi.fn(async () => ({})),
      } as never,
      runs as never,
      [],
      recorder,
    );
    const stream = await harness.stream({
      agent: {},
      execution: {},
      orchestration: orchestration(),
    } as never);

    await stream.fail({ error: "aborted", status: "cancelled" });
    await stream.fail({ error: "ignored" });
    await stream.finalize({}, {});

    expect(runs.cancelWithLease).toHaveBeenCalledOnce();
    expect(runs.succeedWithLease).not.toHaveBeenCalled();
    expect(
      recorder.recordRuntime.mock.calls.map((call: any[]) => call[1].eventType),
    ).toContain("trajectory.cancelled");
  });

  test("durably suspends a stream and gives waiting terminal precedence", async () => {
    const { runs } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(),
        stream: vi.fn(async () => ({})),
      } as never,
      runs as never,
    );
    const stream = await harness.stream({
      agent: {},
      execution: {},
      orchestration: orchestration(),
    } as never);
    const checkpoint = {
      delegationToolCallIds: ["delegate-1"],
      responseMessages: [],
      modelMessages: [],
      modelConfig: { provider: "fake", model: "model" },
      authorizationRecipe: { descriptorIds: ["builtin:generate_report"] },
      assistantMessageId: "assistant-1",
    };

    await stream.waitForExternal(checkpoint);
    await stream.fail({ error: "browser aborted", status: "cancelled" });

    expect(runs.suspendParent).toHaveBeenCalledWith(
      "run-1",
      "lease-1",
      checkpoint,
    );
    expect(runs.cancelWithLease).not.toHaveBeenCalled();
  });

  test("terminalizes a foreground run when suspension has no matching join", async () => {
    const { runs, recorder } = dependencies();
    runs.suspendParent.mockResolvedValueOnce(null as never);
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(),
        stream: vi.fn(async () => ({})),
      } as never,
      runs as never,
      [],
      recorder,
    );
    const stream = await harness.stream({
      agent: {},
      execution: {},
      orchestration: orchestration(),
    } as never);

    await expect(
      stream.waitForExternal({
        delegationToolCallIds: ["failed-call"],
        responseMessages: [],
        modelMessages: [],
        modelConfig: {},
        authorizationRecipe: {},
        assistantMessageId: "assistant-1",
      }),
    ).rejects.toThrow("PARENT_SUSPENSION_REJECTED");

    expect(runs.failWithLease).toHaveBeenCalledWith(
      "run-1",
      "lease-1",
      expect.stringContaining("no matching delegation join"),
      "PARENT_SUSPENSION_REJECTED",
    );
    expect(
      recorder.recordRuntime.mock.calls.map((call: any[]) => call[1].eventType),
    ).toContain("trajectory.failed");
  });

  test("does not report waiting when suspension classifies cancellation", async () => {
    const { runs, recorder } = dependencies();
    runs.suspendParent.mockResolvedValueOnce({
      id: "run-1",
      status: "cancelled",
    } as never);
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(),
        stream: vi.fn(async () => ({})),
      } as never,
      runs as never,
      [],
      recorder,
    );
    const stream = await harness.stream({
      agent: {},
      execution: {},
      orchestration: orchestration(),
    } as never);

    await expect(
      stream.waitForExternal({
        delegationToolCallIds: ["delegate-1"],
        responseMessages: [],
        modelMessages: [],
        modelConfig: {},
        authorizationRecipe: {},
        assistantMessageId: "assistant-1",
      }),
    ).rejects.toThrow("CANCELLED");

    const events = recorder.recordRuntime.mock.calls.map(
      (call: any[]) => call[1].eventType,
    );
    expect(events).toContain("trajectory.cancelled");
    expect(events).not.toContain("trajectory.step_completed");
    expect(runs.failWithLease).not.toHaveBeenCalled();
  });

  test("verifies before success and records verification provenance", async () => {
    const native = { artifact: { artifactId: "artifact-1" } };
    const verifyCompletion = vi.fn(async () => ({
      verified: true as const,
      details: { verifier: "test" },
    }));
    const { runs, recorder } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(async () => native),
        stream: vi.fn(),
      } as never,
      runs as never,
      [],
      recorder,
    );

    await expect(
      harness.generate({
        agent: {},
        execution: {},
        orchestration: orchestration({
          completionRequirement: { verifyCompletion },
        }),
      } as never),
    ).resolves.toBe(native);

    expect(verifyCompletion).toHaveBeenCalledWith(native, {
      userId: "user-1",
      runId: "run-1",
    });
    expect(runs.succeedWithLease).toHaveBeenCalledAfter(verifyCompletion);
    expect(
      recorder.recordRuntime.mock.calls.map((call: any[]) => call[1].eventType),
    ).toEqual([
      "trajectory.started",
      "run.started",
      "routing.resolved",
      "verification.started",
      "verification.completed",
      "trajectory.completed",
      "run.completed",
    ]);
  });

  test("verification failure terminates the run as failed", async () => {
    const verifyCompletion = vi.fn(async () => ({
      verified: false as const,
      reason: "ARTIFACT_HASH_MISMATCH",
    }));
    const { runs, recorder } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(async () => ({ artifact: "report.md" })),
        stream: vi.fn(),
      } as never,
      runs as never,
      [],
      recorder,
    );

    await expect(
      harness.generate({
        agent: {},
        execution: {},
        orchestration: orchestration({
          completionRequirement: { verifyCompletion },
        }),
      } as never),
    ).rejects.toThrow("VERIFICATION_REQUIRED:ARTIFACT_HASH_MISMATCH");

    expect(runs.succeedWithLease).not.toHaveBeenCalled();
    expect(runs.failWithLease).toHaveBeenCalledWith(
      "run-1",
      "lease-1",
      "VERIFICATION_REQUIRED:ARTIFACT_HASH_MISMATCH",
      undefined,
    );
    expect(
      recorder.recordRuntime.mock.calls.map((call: any[]) => call[1].eventType),
    ).toEqual([
      "trajectory.started",
      "run.started",
      "routing.resolved",
      "verification.started",
      "verification.failed",
      "trajectory.failed",
      "run.failed",
    ]);
  });

  test("does not conflict with worker-owned lifecycle in claimed mode", async () => {
    const { runs, recorder } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(async () => ({ text: "complete" })),
        stream: vi.fn(),
      } as never,
      runs as never,
      [],
      recorder,
    );

    await harness.generate({
      agent: {},
      execution: {},
      orchestration: orchestration({
        run: { mode: "claimed", claimToken: "worker-lease" },
      }),
    } as never);

    expect(runs.start).not.toHaveBeenCalled();
    expect(runs.succeedWithLease).not.toHaveBeenCalled();
    const events = recorder.recordRuntime.mock.calls.map(
      (call: any[]) => call[1].eventType,
    );
    expect(events).toContain("routing.resolved");
    expect(events).not.toContain("run.started");
    expect(events).not.toContain("run.completed");
    expect(events).not.toContain("trajectory.started");
    expect(events).not.toContain("trajectory.completed");
  });

  test("claimed generation verifies artifacts before finishing the root", async () => {
    const native = { artifact: { artifactId: "artifact-1" } };
    const verifyCompletion = vi.fn(async () => ({
      verified: false as const,
      reason: "ARTIFACT_HASH_MISMATCH",
    }));
    const { runs } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(async () => native),
        stream: vi.fn(),
      } as never,
      runs as never,
    );
    const generated = await harness.generateClaimed({
      agent: {},
      execution: {},
      orchestration: orchestration({
        completionRequirement: { verifyCompletion },
        run: { mode: "claimed", claimToken: "claim-1" },
      }),
    } as never);

    await expect(generated.finalize({}, native)).rejects.toThrow(
      "VERIFICATION_REQUIRED:ARTIFACT_HASH_MISMATCH",
    );
    expect(runs.finishParentResume).toHaveBeenCalledOnce();
    expect(runs.finishParentResume).toHaveBeenCalledWith(
      "run-1",
      "claim-1",
      expect.objectContaining({
        status: "failed",
        error: "VERIFICATION_REQUIRED:ARTIFACT_HASH_MISMATCH",
      }),
    );
    expect(runs.finishParentResume).not.toHaveBeenCalledWith(
      "run-1",
      "claim-1",
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  test("claimed generation failure is fenced by the harness", async () => {
    const { runs } = dependencies();
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(async () => {
          throw new Error("provider failed");
        }),
        stream: vi.fn(),
      } as never,
      runs as never,
    );

    await expect(
      harness.generateClaimed({
        agent: {},
        execution: {},
        orchestration: orchestration({
          run: { mode: "claimed", claimToken: "claim-1" },
        }),
      } as never),
    ).rejects.toThrow("provider failed");
    expect(runs.finishParentResume).toHaveBeenCalledWith("run-1", "claim-1", {
      status: "failed",
      error: "provider failed",
      errorCode: "PARENT_RESUME_FAILED",
    });
  });

  test.each([
    ["cancelled", "CANCELLED"],
    ["timed_out", "TIMED_OUT"],
  ] as const)(
    "heartbeat %s aborts in-flight claimed generation without success",
    async (heartbeatState, errorCode) => {
      vi.useFakeTimers();
      try {
        let driverSignal: AbortSignal | undefined;
        const { runs, recorder } = dependencies();
        (runs.heartbeat as any).mockResolvedValueOnce(heartbeatState);
        (runs.finishParentResume as any).mockImplementation(
          async (_runId, _token, outcome) => ({
            id: "run-1",
            status: outcome.status,
          }),
        );
        const driver = {
          id: "test",
          generate: vi.fn(({ execution }: any) => {
            driverSignal = execution.abortSignal;
            return new Promise((_resolve, reject) => {
              execution.abortSignal.addEventListener(
                "abort",
                () => reject(execution.abortSignal.reason),
                { once: true },
              );
            });
          }),
          stream: vi.fn(),
        };
        const harness = new IrisHarness(
          driver as never,
          runs as never,
          [],
          recorder,
        );
        const generation = harness.generateClaimed({
          agent: {},
          execution: {},
          orchestration: orchestration({
            run: { mode: "claimed", claimToken: "claim-1" },
          }),
        } as never);
        const rejected = expect(generation).rejects.toThrow(errorCode);

        await vi.advanceTimersByTimeAsync(10_000);

        expect(driverSignal?.aborted).toBe(true);
        expect((driverSignal?.reason as Error).message).toBe(errorCode);
        await rejected;
        expect(runs.finishParentResume).toHaveBeenCalledOnce();
        expect(runs.finishParentResume).toHaveBeenCalledWith(
          "run-1",
          "claim-1",
          expect.objectContaining({ status: heartbeatState, errorCode }),
        );
        expect(runs.finishParentResume).not.toHaveBeenCalledWith(
          "run-1",
          "claim-1",
          expect.objectContaining({ status: "succeeded" }),
        );
        expect(
          recorder.recordRuntime.mock.calls.map(
            (call: any[]) => call[1].eventType,
          ),
        ).not.toContain("trajectory.completed");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("heartbeat lease loss aborts generation without a terminal event", async () => {
    vi.useFakeTimers();
    try {
      const { runs, recorder } = dependencies();
      (runs.heartbeat as any).mockResolvedValueOnce("lease_lost");
      const harness = new IrisHarness(
        {
          id: "test",
          generate: vi.fn(
            ({ execution }: any) =>
              new Promise((_resolve, reject) => {
                execution.abortSignal.addEventListener(
                  "abort",
                  () => reject(execution.abortSignal.reason),
                  { once: true },
                );
              }),
          ),
          stream: vi.fn(),
        } as never,
        runs as never,
        [],
        recorder,
      );
      const generation = harness.generateClaimed({
        agent: {},
        execution: {},
        orchestration: orchestration({
          run: { mode: "claimed", claimToken: "claim-1" },
        }),
      } as never);
      const rejected = expect(generation).rejects.toThrow("LEASE_LOST");

      await vi.advanceTimersByTimeAsync(10_000);

      await rejected;
      expect(runs.finishParentResume).not.toHaveBeenCalled();
      expect(
        recorder.recordRuntime.mock.calls
          .map((call: any[]) => call[1].eventType)
          .filter((eventType) => eventType.startsWith("trajectory.")),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("claimed generation composes and cleans up the caller signal", async () => {
    const caller = new AbortController();
    const removeEventListener = vi.spyOn(caller.signal, "removeEventListener");
    const { runs } = dependencies();
    let driverSignal: AbortSignal | undefined;
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(({ execution }: any) => {
          driverSignal = execution.abortSignal;
          return new Promise<never>((_resolve, reject) => {
            execution.abortSignal.addEventListener(
              "abort",
              () => reject(execution.abortSignal.reason),
              { once: true },
            );
          });
        }),
        stream: vi.fn(),
      } as never,
      runs as never,
    );
    const generation = harness.generateClaimed({
      agent: {},
      execution: { abortSignal: caller.signal },
      orchestration: orchestration({
        run: { mode: "claimed", claimToken: "claim-1" },
      }),
    } as never);

    await vi.waitFor(() => expect(driverSignal).toBeDefined());
    caller.abort(new Error("caller aborted"));

    expect(driverSignal).not.toBe(caller.signal);
    expect(driverSignal?.aborted).toBe(true);
    await expect(generation).rejects.toThrow("caller aborted");
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  test("heartbeats throughout a long generation and stops after success", async () => {
    vi.useFakeTimers();
    try {
      let complete!: (value: { text: string }) => void;
      const generated = new Promise<{ text: string }>((resolve) => {
        complete = resolve;
      });
      const { runs } = dependencies();
      const harness = new IrisHarness(
        {
          id: "test",
          generate: vi.fn(() => generated),
          stream: vi.fn(),
        } as never,
        runs as never,
      );
      const execution = harness.generate({
        agent: {},
        execution: {},
        orchestration: orchestration(),
      } as never);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(runs.heartbeat).toHaveBeenCalledTimes(12);
      expect(runs.heartbeat).toHaveBeenLastCalledWith(
        "run-1",
        "lease-1",
        30_000,
      );

      complete({ text: "complete" });
      await execution;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runs.heartbeat).toHaveBeenCalledTimes(12);
    } finally {
      vi.useRealTimers();
    }
  });

  test("heartbeats a stream until its idempotent finalization settles", async () => {
    vi.useFakeTimers();
    try {
      const { runs } = dependencies();
      const harness = new IrisHarness(
        {
          id: "test",
          generate: vi.fn(),
          stream: vi.fn(async () => ({})),
        } as never,
        runs as never,
      );
      const stream = await harness.stream({
        agent: {},
        execution: {},
        orchestration: orchestration(),
      } as never);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(runs.heartbeat).toHaveBeenCalledTimes(12);

      const first = stream.finalize({}, {});
      const second = stream.finalize({}, {});
      await Promise.all([first, second]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(runs.heartbeat).toHaveBeenCalledTimes(12);
      expect(runs.succeedWithLease).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports lease loss without recording a completed trajectory", async () => {
    const { runs, recorder } = dependencies();
    runs.succeedWithLease.mockResolvedValueOnce(null as never);
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(),
        stream: vi.fn(async () => ({})),
      } as never,
      runs as never,
      [],
      recorder,
    );
    const stream = await harness.stream({
      agent: {},
      execution: {},
      orchestration: orchestration(),
    } as never);

    await expect(stream.finalize({}, {})).rejects.toThrow("LEASE_LOST");
    expect(
      recorder.recordRuntime.mock.calls.map((call: any[]) => call[1].eventType),
    ).not.toContain("trajectory.completed");
    expect(runs.failWithLease).not.toHaveBeenCalled();
  });

  test("does not record failure when the failed terminal transition loses its lease", async () => {
    const { runs, recorder } = dependencies();
    runs.failWithLease.mockResolvedValueOnce(null as never);
    const harness = new IrisHarness(
      {
        id: "test",
        generate: vi.fn(),
        stream: vi.fn(async () => ({})),
      } as never,
      runs as never,
      [],
      recorder,
    );
    const stream = await harness.stream({
      agent: {},
      execution: {},
      orchestration: orchestration(),
    } as never);

    await expect(stream.fail({ error: "provider failed" })).rejects.toThrow(
      "LEASE_LOST",
    );
    expect(
      recorder.recordRuntime.mock.calls.map((call: any[]) => call[1].eventType),
    ).not.toContain("trajectory.failed");
  });

  test.each(["stream", "generate"] as const)(
    "rejects %s before driver execution when orchestration is omitted",
    async (method) => {
      const driver = {
        id: "test",
        generate: vi.fn(async () => ({})),
        stream: vi.fn(async () => ({})),
      };
      const harness = new IrisHarness(driver as never);

      await expect(
        harness[method]({ agent: {}, execution: {} } as never),
      ).rejects.toThrow("HARNESS_ORCHESTRATION_REQUIRED");
      expect(driver[method]).not.toHaveBeenCalled();
    },
  );

  test("delegates durable cancellation to RunManager", async () => {
    const requestCancellation = vi.fn(async () => ({ id: "run-1" }));
    const harness = new IrisHarness(
      {} as never,
      { requestCancellation } as never,
    );

    await expect(harness.cancel("run-1", "user-1")).resolves.toEqual({
      id: "run-1",
    });
    expect(requestCancellation).toHaveBeenCalledWith("run-1", "user-1");
  });
});
