import { describe, expect, test, vi } from "vitest";
import {
  createAutomationExecutionAdapter,
  type AutomationExecutionDependencies,
  type AutomationExecutionRequest,
} from "./execution-adapter";

vi.mock("server-only", () => ({}));

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
  };
}

describe("automation execution adapter", () => {
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
});
