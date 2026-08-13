import { describe, expect, it } from "vitest";
import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import {
  getAgentToolTimeouts,
  getToolLoopAgentReasoningMode,
} from "./create-tool-loop-agent";

describe("getAgentToolTimeouts", () => {
  it("uses AI SDK v7 per-tool timeout keys and risk-based durations", () => {
    const timeouts = getAgentToolTimeouts({
      [DefaultToolName.WebSearch]: {} as any,
      [DefaultToolName.PythonExecution]: {} as any,
      [ImageToolName]: {} as any,
      workflow: { _workflowId: "workflow-1" } as any,
      mcpUnknown: {} as any,
    });

    expect(timeouts).toEqual({
      webSearchMs: 15_000,
      "python-executionMs": 45_000,
      "image-managerMs": 120_000,
      workflowMs: 120_000,
      mcpUnknownMs: 30_000,
    });
  });

  it("uses automatic reasoning for the implicit base agent", () => {
    expect(getToolLoopAgentReasoningMode({ type: "base" })).toBe("auto");
    expect(
      getToolLoopAgentReasoningMode({
        type: "custom",
        agent: { instructions: { reasoningMode: "high" } } as any,
      }),
    ).toBe("high");
  });
});
