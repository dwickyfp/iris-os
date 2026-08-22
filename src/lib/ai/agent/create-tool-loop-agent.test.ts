import { DefaultToolName, ImageToolName } from "lib/ai/tools";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createToolLoopAgent,
  evaluateToolCallPolicy,
  getAgentToolTimeouts,
  getToolLoopAgentReasoningMode,
} from "./create-tool-loop-agent";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function modelResult(content: any[], finishReason = "stop") {
  return {
    content,
    finishReason: { unified: finishReason, raw: finishReason },
    usage,
    warnings: [],
  } as any;
}

function runtimeContext() {
  return {
    requestId: "request-1",
    runId: "run-1",
    userId: "user-1",
    agentType: "base" as const,
    toolMode: "auto" as const,
    approvalPolicy: "never" as const,
    skills: [],
  };
}

function eventTypes(events: Array<{ type: string }>) {
  return events.map(({ type }) => type);
}

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

describe("accurate runtime event boundaries", () => {
  it("orders successful model and tool events without step-end duplicates", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const execute = vi.fn(async () => "ok");
    const model = new MockLanguageModelV3({
      doGenerate: [
        modelResult(
          [
            {
              type: "tool-call",
              toolCallId: "tool-1",
              toolName: "search",
              input: JSON.stringify({ query: "iris" }),
            },
          ],
          "tool-calls",
        ),
        modelResult([{ type: "text", text: "complete" }]),
      ],
    });
    const agent = createToolLoopAgent({
      profile: { type: "base" },
      model,
      instructions: "test",
      tools: { search: tool({ inputSchema: z.object({ query: z.string() }), execute }) },
      runtimeContext: runtimeContext(),
      onRuntimeEvent: async (type, payload) => {
        events.push({ type, payload });
      },
    });

    await agent.generate({ prompt: "search" });

    expect(eventTypes(events)).toEqual([
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.started",
      "tool.completed",
      "model.requested",
      "model.completed",
    ]);
    expect(events[0].payload).toHaveProperty("startedAt");
    expect(events[1].payload).toMatchObject({
      completedAt: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(events[4].payload).toMatchObject({
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      durationMs: expect.any(Number),
    });
  });

  it("records model failure immediately after a provider exception", async () => {
    const events: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("provider unavailable");
      },
    });
    const agent = createToolLoopAgent({
      profile: { type: "base" },
      model,
      instructions: "test",
      tools: {},
      runtimeContext: runtimeContext(),
      onRuntimeEvent: async (type) => {
        events.push(type);
      },
    });

    await expect(agent.generate({ prompt: "fail" })).rejects.toThrow(
      "provider unavailable",
    );
    expect(events).toEqual(["model.requested", "model.failed"]);
  });

  it("terminalizes policy denial without starting the tool", async () => {
    const events: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: modelResult(
        [
          {
            type: "tool-call",
            toolCallId: "tool-denied",
            toolName: "write",
            input: JSON.stringify({ value: "x" }),
          },
        ],
        "tool-calls",
      ),
    });
    const agent = createToolLoopAgent({
      profile: { type: "base" },
      model,
      instructions: "test",
      tools: {
        write: tool({
          inputSchema: z.object({ value: z.string() }),
          execute: async () => "never",
        }),
      },
      runtimeContext: runtimeContext(),
      resolvedPolicy: {
        approvalPolicy: "never",
        tools: {},
        authority: { maximumRisks: ["read"] },
        capabilities: {
          write: { id: "builtin:write", key: "write", risks: ["write"] },
        },
      },
      onRuntimeEvent: async (type) => {
        events.push(type);
      },
    });

    await expect(agent.generate({ prompt: "write" })).rejects.toThrow(
      "POLICY_DENIED",
    );
    expect(events).toEqual([
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.failed",
    ]);
  });

  it("records exactly one failed terminal when tool execution throws", async () => {
    const events: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: [
        modelResult(
          [
            {
              type: "tool-call",
              toolCallId: "tool-error",
              toolName: "search",
              input: JSON.stringify({ query: "iris" }),
            },
          ],
          "tool-calls",
        ),
        modelResult([{ type: "text", text: "handled" }]),
      ],
    });
    const agent = createToolLoopAgent({
      profile: { type: "base" },
      model,
      instructions: "test",
      tools: {
        search: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async () => {
            throw new Error("tool exploded");
          },
        } as any),
      },
      runtimeContext: runtimeContext(),
      onRuntimeEvent: async (type) => {
        events.push(type);
      },
    });

    await agent.generate({ prompt: "search" });
    expect(events).toEqual([
      "model.requested",
      "model.completed",
      "tool.requested",
      "tool.started",
      "tool.failed",
      "model.requested",
      "model.completed",
    ]);
    expect(events.filter((type) => type === "tool.failed")).toHaveLength(1);
  });

  it.each([
    { approved: true, lifecycle: ["tool.approved", "tool.started", "tool.completed"] },
    { approved: false, lifecycle: ["tool.rejected", "tool.cancelled"] },
  ])(
    "records the approval lifecycle when approved is $approved",
    async ({ approved, lifecycle }) => {
      const events: string[] = [];
      const execute = vi.fn(async () => "written");
      const model = new MockLanguageModelV3({
        doGenerate: [
          modelResult(
            [
              {
                type: "tool-call",
                toolCallId: "approval-tool",
                toolName: "write",
                input: JSON.stringify({ value: "x" }),
              },
            ],
            "tool-calls",
          ),
          modelResult([{ type: "text", text: "done" }]),
        ],
      });
      const agent = createToolLoopAgent({
        profile: { type: "base" },
        model,
        instructions: "test",
        tools: {
          write: tool({
            inputSchema: z.object({ value: z.string() }),
            execute,
          }),
        },
        runtimeContext: {
          ...runtimeContext(),
          approvalPolicy: "destructive_only",
        },
        resolvedPolicy: {
          approvalPolicy: "destructive_only",
          tools: {},
          capabilities: {
            write: { id: "builtin:write", key: "write", risks: ["write"] },
          },
        },
        onRuntimeEvent: async (type) => {
          events.push(type);
        },
      });
      const requested = await agent.generate({ prompt: "write" });
      const approvalRequest = requested.response.messages
        .flatMap((message: any) => message.content ?? [])
        .find((part: any) => part.type === "tool-approval-request");

      await agent.generate({
        messages: [
          ...requested.response.messages,
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: approvalRequest.approvalId,
                approved,
              },
            ],
          },
        ],
      } as any);

      expect(events).toEqual([
        "model.requested",
        "model.completed",
        "tool.requested",
        "tool.approval_requested",
        ...lifecycle,
        "model.requested",
        "model.completed",
      ]);
      expect(execute).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(
        events.filter((type) =>
          ["tool.completed", "tool.failed", "tool.cancelled"].includes(type),
        ),
      ).toHaveLength(1);
    },
  );
});
