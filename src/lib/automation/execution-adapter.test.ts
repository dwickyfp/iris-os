import { describe, expect, test, vi } from "vitest";
import {
  createAutomationExecutionAdapter,
  mapWorkflowOutput,
  runHeadlessAgent,
  type AutomationExecutionDependencies,
  type AutomationExecutionRequest,
} from "./execution-adapter";
import { customModelProvider } from "lib/ai/models";

vi.mock("server-only", () => ({}));
vi.mock("lib/ai/models", () => ({
  customModelProvider: { getEngineModel: vi.fn() },
}));

function request(
  targetType: AutomationExecutionRequest["targetType"],
): AutomationExecutionRequest {
  return {
    runId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    targetType,
    targetId: crypto.randomUUID(),
    input: { objective: "Do the bounded work" },
    timeoutMs: 1_000,
    signal: new AbortController().signal,
    executionSource: "automation",
  };
}

describe("automation execution adapter", () => {
  test("maps actual workflow node outputs", () => {
    const outputs = { report: { url: "https://example.com/report" } };
    expect(mapWorkflowOutput({ outputs, histories: [] })).toBe(outputs);
  });
  test("executes headless agents through the Harness contract", async () => {
    const input = request("skill");
    input.input = { prompt: "  Use the fallback prompt  " };
    const generate = vi.fn(async () => ({
      text: "x".repeat(32_001),
      usage: { totalTokens: 42 },
    }));
    vi.mocked(customModelProvider.getEngineModel).mockResolvedValue(
      {} as never,
    );

    await expect(
      runHeadlessAgent({
        request: input,
        profile: { type: "base" },
        instructions: "Execute the skill",
        allowedTools: [],
        harness: { generate },
      }),
    ).resolves.toEqual({
      status: "succeeded",
      output: { text: "x".repeat(32_000), totalTokens: 42 },
    });

    expect(customModelProvider.getEngineModel).toHaveBeenCalledWith(
      "automation-runner",
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          instructions: "Execute the skill",
          tools: {},
        }),
        execution: {
          prompt: "Use the fallback prompt",
          abortSignal: input.signal,
          timeout: input.timeoutMs,
        },
        orchestration: expect.objectContaining({
          identity: expect.objectContaining({
            runId: input.runId,
            userId: input.userId,
          }),
        }),
      }),
    );
  });

  test.each(["workflow", "skill", "agent"] as const)(
    "dispatches %s to the existing-runtime adapter",
    async (targetType) => {
      const executor = vi.fn(async () => ({
        status: "succeeded" as const,
        output: { targetType },
      }));
      const dependencies = {
        workflow: executor,
        skill: executor,
        agent: executor,
      } satisfies AutomationExecutionDependencies;
      await expect(
        createAutomationExecutionAdapter(dependencies)(request(targetType)),
      ).resolves.toMatchObject({ status: "succeeded" });
      expect(executor).toHaveBeenCalledOnce();
    },
  );

  test("does not invoke a target after cancellation", async () => {
    const executor = vi.fn();
    const controller = new AbortController();
    controller.abort();
    const input = { ...request("agent"), signal: controller.signal };
    const dependencies = {
      workflow: executor,
      skill: executor,
      agent: executor,
    } as AutomationExecutionDependencies;
    await expect(
      createAutomationExecutionAdapter(dependencies)(input),
    ).resolves.toEqual({ status: "cancelled", message: "Run was cancelled" });
    expect(executor).not.toHaveBeenCalled();
  });

  test("returns structured retryable failures", async () => {
    const failing = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const dependencies = {
      workflow: failing,
      skill: failing,
      agent: failing,
    } satisfies AutomationExecutionDependencies;
    await expect(
      createAutomationExecutionAdapter(dependencies)(request("skill")),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "EXECUTION_ERROR",
      retryable: true,
    });
  });

  test("preserves verification failures as non-retryable", async () => {
    const failing = vi.fn(async () => {
      throw new Error("VERIFICATION_REQUIRED:ARTIFACT_HASH_MISMATCH");
    });
    const dependencies = {
      workflow: failing,
      skill: failing,
      agent: failing,
    } satisfies AutomationExecutionDependencies;

    await expect(
      createAutomationExecutionAdapter(dependencies)(request("skill")),
    ).resolves.toEqual({
      status: "failed",
      errorCode: "VERIFICATION_REQUIRED",
      message: "VERIFICATION_REQUIRED:ARTIFACT_HASH_MISMATCH",
      retryable: false,
    });
  });
});
