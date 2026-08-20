import { customModelProvider } from "lib/ai/models";
import { describe, expect, test, vi } from "vitest";
import {
  type AutomationExecutionDependencies,
  type AutomationExecutionRequest,
  createAutomationExecutionAdapter,
  mapWorkflowOutput,
  runHeadlessAgent,
} from "./execution-adapter";

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
          instructions: expect.stringContaining("Execute the skill"),
          tools: {},
        }),
        execution: {
          prompt: "Use the fallback prompt",
          abortSignal: input.signal,
          timeout: input.timeoutMs,
        },
        orchestration: expect.objectContaining({
          identity: expect.objectContaining({
            userId: input.userId,
          }),
          run: {
            mode: "create",
            spec: expect.objectContaining({
              context: expect.objectContaining({
                automationRunId: input.runId,
              }),
            }),
          },
        }),
      }),
    );
    const generatedInput = (generate.mock.calls as any[][])[0][0];
    expect(generatedInput.orchestration.identity.runId).not.toBe(input.runId);
    expect(generatedInput.agent.runtimeContext.runId).toBe(
      generatedInput.orchestration.identity.runId,
    );
  });

  test("claims an existing worker-owned AgentRun without creating another", async () => {
    const input = {
      ...request("agent"),
      executionSource: "delegation" as const,
      claimToken: "lease-1",
    };
    const generate = vi.fn(async () => ({
      text: "complete",
      usage: { totalTokens: 1 },
    }));
    vi.mocked(customModelProvider.getEngineModel).mockResolvedValue(
      {} as never,
    );

    await runHeadlessAgent({
      request: input,
      profile: { type: "base" },
      instructions: "Execute delegated work",
      allowedTools: [],
      harness: { generate },
    });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestration: expect.objectContaining({
          identity: expect.objectContaining({ runId: input.runId }),
          run: { mode: "claimed", claimToken: "lease-1" },
        }),
      }),
    );
  });

  test("persists and enforces the normalized automation goal requirement", async () => {
    const input = request("agent");
    input.input = { objective: "create Q2 revenue PDF report" };
    input.allowedTools = ["generate_report"];
    const generate = vi.fn(async () => ({
      text: "complete",
      usage: { totalTokens: 1 },
    }));
    vi.mocked(customModelProvider.getEngineModel).mockResolvedValue({} as never);

    await runHeadlessAgent({
      request: input,
      profile: { type: "base" },
      instructions: "Execute",
      allowedTools: input.allowedTools,
      harness: { generate },
    });

    const orchestration = (generate.mock.calls as any[][])[0][0].orchestration;
    expect(orchestration.run.spec.context.goalRequirement).toMatchObject({
      level: "artifact",
      requiredMediaTypes: ["application/pdf"],
      requiredPeriod: "Q2",
      requiredCapabilities: ["analysis", "generate_report"],
    });
    expect(orchestration.completionRequirement).toBeDefined();
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
