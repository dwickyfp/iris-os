import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import { describe, expect, it } from "vitest";
import {
  evaluateToolCallPolicy,
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

  it("routes tool calls through destination-aware policy evaluation", () => {
    const decision = evaluateToolCallPolicy({
      toolName: DefaultToolName.Http,
      args: { url: "https://api.example.test/orders" },
      runtimeContext: {
        requestId: "request-1",
        runId: "run-1",
        userId: "user-1",
        agentType: "custom",
        agentId: "agent-1",
        toolMode: "auto",
        approvalPolicy: "destructive_only",
        skills: [],
      },
      resolvedPolicy: {
        version: 2,
        approvalPolicy: "destructive_only",
        tools: {},
        capabilities: {
          [DefaultToolName.Http]: {
            id: `builtin:${DefaultToolName.Http}`,
            key: DefaultToolName.Http,
            risks: ["write", "network"],
          },
        },
      },
    });

    expect(decision).toMatchObject({
      result: "approval",
      risks: ["write", "network"],
      destination: { kind: "network", uri: "https://api.example.test/orders" },
      capability: { id: `builtin:${DefaultToolName.Http}` },
    });
  });

  it("does not let approval-disabled child execution exceed authority", () => {
    const decision = evaluateToolCallPolicy({
      toolName: DefaultToolName.PythonExecution,
      args: { code: "print('hello')" },
      runtimeContext: {
        requestId: "request-1",
        runId: "child-1",
        parentRunId: "parent-1",
        userId: "user-1",
        agentType: "custom",
        agentId: "agent-1",
        toolMode: "auto",
        approvalPolicy: "never",
        skills: [],
      },
      resolvedPolicy: {
        version: 2,
        approvalPolicy: "never",
        tools: {},
        authority: { maximumRisks: ["read"] },
      },
    });

    expect(decision.result).toBe("deny");
    expect(decision.reasons).toContain("risk_outside_authority");
    expect(decision.runtime.kind).toBe("local_delegation");
  });
});
