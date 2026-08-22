import { customModelProvider } from "lib/ai/models";
import { BudgetExhaustedError } from "lib/ai/runtime/budget";
import type { AgentRun } from "lib/ai/runs/types";
import { createDelegationWorkerExecutor } from "lib/delegation/worker-executor";
import { describe, expect, test, vi } from "vitest";
import {
  type AutomationExecutionDependencies,
  type AutomationExecutionRequest,
  classifyWorkflowFailure,
  createAutomationExecutionAdapter,
  executeWorkflowAutomation,
  finishWorkflowAgentRun,
  mapWorkflowOutput,
  projectAutomationExecutionResult,
  runHeadlessAgent,
} from "./execution-adapter";

vi.mock("server-only", () => ({}));
vi.mock("lib/ai/models", () => ({
  customModelProvider: { getEngineModel: vi.fn() },
}));
vi.mock("lib/ai/skill/scoped-learned", () => ({
  selectScopedLearnedSkillSummaries: vi.fn(async () => []),
}));
vi.mock("lib/db/repository", () => ({
  agentRepository: {
    selectAgentsByUserId: vi.fn(async () => []),
  },
  agentRunRepository: {},
  artifactRepository: {},
  remoteAgentRepository: {
    listByUserId: vi.fn(async () => []),
  },
  workflowRepository: {
    selectExecuteAbility: vi.fn(async () => []),
  },
  skillRepository: {
    selectSkillSummariesByAgentId: vi.fn(async () => []),
  },
}));
vi.mock("lib/ai/mcp/mcp-manager", () => ({
  mcpClientsManager: { tools: () => ({}) },
}));
vi.mock("lib/sandbox/server", () => ({
  sandboxCapability: {
    provider: {
      name: "test",
      status: async () => ({ ready: false, checkedAt: new Date(0) }),
    },
    pythonCompute: {},
  },
  sandboxManager: { cancelByRun: vi.fn(async () => undefined) },
  workflowSandboxServices: () => ({}),
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
      resolveBudget: async () => ({ maxTokens: 5_000 }),
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

  test("worker passes the persisted exact tool set into the production headless adapter", async () => {
    const parent = {
      id: "parent-1",
      status: "running",
      cancelRequestedAt: null,
    } as unknown as AgentRun;
    const child = {
      id: "child-1",
      userId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      parentRunId: parent.id,
      rootRunId: parent.id,
      workspaceId: null,
      taskId: null,
      status: "queued",
      context: {
        objective: "Use only the persisted capability",
        policyAuthority: {
          capabilityIds: ["tool:allowed", "tool:forbidden"],
        },
      },
      allowedTools: ["allowed"],
      timeoutMs: 1_000,
      depth: 1,
      tokenBudget: 1_000,
      absoluteDeadlineAt: new Date(Date.now() + 60_000),
      cancelRequestedAt: null,
    } as unknown as AgentRun;
    const claimed = { ...child, status: "running" as const };
    const generate = vi.fn(async () => ({
      text: "complete",
      usage: { totalTokens: 1 },
    }));
    const tools = {
      allowed: { execute: vi.fn() },
      forbidden: { execute: vi.fn() },
    };
    const capabilitiesModule = await import(
      "lib/ai/runtime/capabilities/server"
    );
    vi.spyOn(
      capabilitiesModule,
      "buildServerCapabilityResolutionInput",
    ).mockResolvedValue({} as never);
    vi.spyOn(capabilitiesModule, "resolveServerCapabilities").mockResolvedValue({
      ordered: [
        { id: "tool:allowed", key: "allowed", kind: "tool" },
        { id: "tool:forbidden", key: "forbidden", kind: "tool" },
      ],
      model: tools,
      eligibleDelegationTargets: [],
      routing: {},
    } as never);
    vi.mocked(customModelProvider.getEngineModel).mockResolvedValue({} as never);
    const executeLocal = (workerRequest: any) =>
      runHeadlessAgent({
        request: workerRequest,
        profile: { type: "base" },
        instructions: "Execute delegated work",
        allowedTools: workerRequest.allowedTools,
        harness: { generate },
        resolveBudget: async () => ({ maxTokens: 1_000 }),
      });
    const finish = vi.fn(async () => ({
      ...claimed,
      status: "succeeded" as const,
    }));
    const runs = {
      claim: vi.fn(async () => ({ run: claimed, token: "lease-1" })),
      heartbeat: vi.fn(async () => "active" as const),
      isCancellationRequested: vi.fn(async () => false),
      succeedWithLease: finish,
      failWithLease: vi.fn(),
      exhaustBudgetWithLease: vi.fn(),
      cancelWithLease: vi.fn(),
      timeOutWithLease: vi.fn(),
      cancelQueued: vi.fn(),
    };
    await createDelegationWorkerExecutor({
      runs: runs as any,
      selectRun: async (id) => (id === child.id ? child : parent),
      selectDelegation: async () => ({
        targetKind: "local_agent",
        remoteAgentId: null,
      }),
      remote: {} as any,
      executeLocal,
      enqueue: vi.fn(async () => true),
      markDispatched: vi.fn(),
      decryptCredential: String,
      recordEvent: vi.fn(),
      ingestRemoteArtifacts: vi.fn(),
      pollMs: 60_000,
    })(child.id);

    const execution = (generate.mock.calls as any[][])[0][0];
    expect(Object.keys(execution.agent.tools)).toEqual(["allowed"]);
    expect(execution.agent.tools).not.toHaveProperty("forbidden");
    expect(execution.orchestration.policy.authority.capabilityIds).toEqual([
      "tool:allowed",
    ]);
    expect(finish).toHaveBeenCalledOnce();
  });

  test("persists and enforces the normalized automation goal requirement", async () => {
    const input = request("agent");
    input.input = { objective: "create Q2 revenue PDF report" };
    input.allowedTools = ["generate_report"];
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
      instructions: "Execute",
      allowedTools: input.allowedTools,
      harness: { generate },
    });

    const orchestration = (generate.mock.calls as any[][])[0][0].orchestration;
    expect(orchestration.run.spec.context.goalRequirement).toMatchObject({
      level: "artifact",
      requiredMediaTypes: ["application/pdf"],
      requiredPeriod: "Q2",
      requiredCapabilities: ["generate_report"],
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

  test("does not misclassify an explicit worker timeout as cancellation", async () => {
    const executor = vi.fn();
    const controller = new AbortController();
    controller.abort(new DOMException("Run timed out", "TimeoutError"));
    const input = { ...request("agent"), signal: controller.signal };
    const dependencies = {
      workflow: executor,
      skill: executor,
      agent: executor,
    } as AutomationExecutionDependencies;
    await expect(
      createAutomationExecutionAdapter(dependencies)(input),
    ).resolves.toEqual({ status: "timed_out", message: "Run timed out" });
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

  test("projects budget exhaustion to both automation terminal records", () => {
    expect(
      projectAutomationExecutionResult({
        status: "budget_exhausted",
        message: "Run budget exhausted: maxTokens",
      }),
    ).toEqual({
      status: "budget_exhausted",
      attemptStatus: "budget_exhausted",
      retryable: false,
      error: "Run budget exhausted: maxTokens",
      errorCode: "BUDGET_EXHAUSTED",
      output: null,
    });
  });

  test("classifies workflow-created AgentRun budget exhaustion", async () => {
    const manager = {
      succeed: vi.fn(),
      fail: vi.fn(),
      exhaustBudget: vi.fn(),
      cancel: vi.fn(),
      timeOut: vi.fn(),
    };
    const error = new BudgetExhaustedError("maxTokens", {
      steps: 1,
      tokens: 11,
      toolCalls: 0,
      delegations: 0,
      depth: 0,
      parallel: 0,
      cost: 0,
      durationMs: 1,
      computeMs: 0,
    });

    await finishWorkflowAgentRun(
      "workflow-run",
      { isOk: false, error },
      manager,
    );

    expect(manager.exhaustBudget).toHaveBeenCalledWith(
      "workflow-run",
      "Run budget exhausted: maxTokens",
    );
    expect(manager.fail).not.toHaveBeenCalled();
    expect(classifyWorkflowFailure(error)).toEqual({
      status: "budget_exhausted",
      message: "Run budget exhausted: maxTokens",
    });
  });

  test("terminalizes a thrown workflow executor failure and always cleans up", async () => {
    const manager = {
      start: vi.fn(async () => undefined),
      succeed: vi.fn(),
      fail: vi.fn(async () => undefined),
      exhaustBudget: vi.fn(),
      cancel: vi.fn(),
      timeOut: vi.fn(),
    };
    const cleanup = vi.fn(async () => true);
    const executor = vi.fn(() => ({
      run: vi.fn(async () => {
        throw new Error("executor exploded");
      }),
    }));

    await expect(
      executeWorkflowAutomation({
        request: request("workflow"),
        workflow: { nodes: [], edges: [] },
        manager: manager as never,
        executor: executor as never,
        cleanup,
        resolveBudget: async () => ({ maxTokens: 100 }) as never,
      }),
    ).resolves.toMatchObject({ status: "failed", message: "executor exploded" });
    expect(manager.fail).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  test("falls back to failed and surfaces cleanup when terminalization throws", async () => {
    const manager = {
      start: vi.fn(async () => undefined),
      succeed: vi.fn(async () => {
        throw new Error("terminalization exploded");
      }),
      fail: vi.fn(async () => undefined),
      exhaustBudget: vi.fn(),
      cancel: vi.fn(),
      timeOut: vi.fn(),
    };
    const cleanup = vi.fn(async () => {
      throw new Error("cleanup exploded");
    });

    await expect(
      executeWorkflowAutomation({
        request: request("workflow"),
        workflow: { nodes: [], edges: [] },
        manager: manager as never,
        executor: (() => ({
          run: async () => ({ isOk: true, output: { ok: true } }),
        })) as never,
        cleanup,
        resolveBudget: async () => ({ maxTokens: 100 }) as never,
      }),
    ).rejects.toThrow("Workflow terminalization and cleanup failed");
    expect(manager.succeed).toHaveBeenCalledOnce();
    expect(manager.fail).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  test("records cleanup failure without masking a primary workflow failure", async () => {
    const manager = {
      start: vi.fn(async () => undefined),
      succeed: vi.fn(),
      fail: vi.fn(async () => undefined),
      exhaustBudget: vi.fn(),
      cancel: vi.fn(),
      timeOut: vi.fn(),
    };
    await expect(
      executeWorkflowAutomation({
        request: request("workflow"),
        workflow: { nodes: [], edges: [] },
        manager: manager as never,
        executor: (() => ({
          run: async () => ({ isOk: false, error: new Error("primary") }),
        })) as never,
        cleanup: async () => {
          throw new Error("cleanup");
        },
        resolveBudget: async () => ({ maxTokens: 100 }) as never,
      }),
    ).resolves.toMatchObject({
      status: "failed",
      message: "primary; cleanup failed: cleanup",
    });
    expect(manager.fail).toHaveBeenCalledOnce();
  });

  test("classifies exact coded failures without fragile message matching", async () => {
    const failing = vi.fn(async () => {
      throw Object.assign(new Error("limit reached"), {
        code: "BUDGET_EXHAUSTED",
      });
    });
    const dependencies = {
      workflow: failing,
      skill: failing,
      agent: failing,
    } satisfies AutomationExecutionDependencies;

    await expect(
      createAutomationExecutionAdapter(dependencies)(request("agent")),
    ).resolves.toEqual({
      status: "budget_exhausted",
      message: "limit reached",
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
