import { describe, expect, it, vi } from "vitest";
import {
  createParentResumeExecutor,
  replaceJoinedToolResults,
  resolveParentResumeAuthorization,
  successfulDelegationToolCallIds,
} from "./parent-resume-executor";

vi.mock("server-only", () => ({}));

function claimed() {
  return {
    run: { id: "root-1" },
    token: "lease-1",
    checkpoint: {
      generation: 1,
      delegationToolCallIds: [],
      assistantMessageId: "assistant-root-1",
      modelConfig: { provider: "fake", model: "fake-a2a" },
      authorizationRecipe: { threadId: "thread-1" },
      responseMessages: [],
      modelMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "delegate_agent",
              input: { objective: "research" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "delegate_agent",
              output: { type: "json", value: { status: "accepted" } },
            },
          ],
        },
      ],
    },
    joins: [
      {
        checkpointGeneration: 1,
        toolCallId: "call-1",
        childRunId: "child-1",
        observation: {
          childRunId: "child-1",
          status: "succeeded",
          result: { facts: ["durable result"] },
        },
      },
    ],
  } as any;
}

describe("parent resume executor", () => {
  it("requires an accepted result for the exact delegate tool call", () => {
    const assistant = {
      role: "assistant" as const,
      content: [
        {
          type: "tool-call",
          toolCallId: "new-call",
          toolName: "delegate_agent",
        },
      ],
    };
    expect(
      successfulDelegationToolCallIds([
        assistant,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "old-call",
              toolName: "delegate_agent",
              output: {
                type: "json",
                value: { status: "accepted", childRunId: "old-child" },
              },
            },
            {
              type: "tool-result",
              toolCallId: "new-call",
              toolName: "delegate_agent",
              output: { type: "error", value: "failed" },
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  it("finalizes instead of checkpointing a failed delegate call", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const execute = createParentResumeExecutor({
      claim: vi.fn(async () => claimed()),
      resolve: vi.fn(async () => ({
        generate: async () => ({
          text: "Delegation failed",
          responseMessages: [
            {
              role: "assistant" as const,
              content: [
                {
                  type: "tool-call",
                  toolCallId: "failed-call",
                  toolName: "delegate_agent",
                },
              ],
            },
            {
              role: "tool" as const,
              content: [
                {
                  type: "tool-result",
                  toolCallId: "failed-call",
                  toolName: "delegate_agent",
                  output: { type: "error", value: "queue unavailable" },
                },
              ],
            },
          ],
          signal: new AbortController().signal,
          assertActive: vi.fn(),
          fail: vi.fn(async () => undefined),
          finalize,
          checkpoint,
        }),
      })),
      saveAssistant: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    });

    await execute("root-1");

    expect(checkpoint).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("preserves the resolved approval decision for resumed high-risk tools", () => {
    const resolvedPolicy = {
      approvalPolicy: "destructive_only" as const,
      tools: {
        "python-execution": {
          toolName: "python-execution",
          readOnly: false,
          requiresApproval: true,
          reason: "high_risk" as const,
        },
      },
    };

    expect(
      resolveParentResumeAuthorization({
        toolChoice: "auto",
        autonomy: "standard",
        resolvedPolicy,
      }),
    ).toEqual({ toolChoice: "auto", resolvedPolicy });
    expect(() =>
      resolveParentResumeAuthorization({
        toolChoice: "auto",
        autonomy: "standard",
      }),
    ).toThrow("PARENT_RESUME_POLICY_REQUIRED");
  });

  it("replaces the accepted result by exact toolCallId", () => {
    const messages = replaceJoinedToolResults(
      claimed().checkpoint.modelMessages,
      claimed().joins,
    );
    expect((messages[1] as any).content[0]).toMatchObject({
      toolCallId: "call-1",
      output: {
        type: "json",
        value: { status: "succeeded", result: { facts: ["durable result"] } },
      },
    });
  });

  it("runs fake A2A rejoin through generate_report and succeeds the root", async () => {
    const saveAssistant = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const generate = vi.fn(async (messages: any[]) => {
      expect(messages[1].content[0].output.value.status).toBe("succeeded");
      return {
        text: "Final report generated.",
        responseMessages: [
          {
            role: "assistant" as const,
            content: [
              {
                type: "tool-call",
                toolCallId: "report-1",
                toolName: "generate_report",
                input: { filename: "report.md" },
              },
            ],
          },
          {
            role: "tool" as const,
            content: [
              {
                type: "tool-result",
                toolCallId: "report-1",
                toolName: "generate_report",
                output: { type: "json", value: { artifactId: "artifact-1" } },
              },
            ],
          },
          {
            role: "assistant" as const,
            content: [{ type: "text", text: "Final report generated." }],
          },
        ],
        usage: { totalTokens: 42 },
        signal: new AbortController().signal,
        assertActive: vi.fn(),
        fail: vi.fn(async () => undefined),
        finalize,
        checkpoint: vi.fn(async () => undefined),
      };
    });
    const execute = createParentResumeExecutor({
      claim: vi.fn(async () => claimed()),
      resolve: vi.fn(async () => ({ generate })),
      saveAssistant,
      fail: vi.fn(async () => undefined),
    });

    await execute("root-1");

    expect(saveAssistant).toHaveBeenCalledWith({
      threadId: "thread-1",
      messageId: "assistant-root-1",
      parts: [
        {
          type: "tool-generate_report",
          toolCallId: "report-1",
          state: "output-available",
          input: { filename: "report.md" },
          output: { artifactId: "artifact-1" },
        },
        { type: "text", text: "Final report generated." },
      ],
      modelConfig: { provider: "fake", model: "fake-a2a" },
    });
    expect(finalize).toHaveBeenCalledWith(
      { assistantMessageId: "assistant-root-1", totalTokens: 42 },
      expect.arrayContaining([expect.objectContaining({ role: "tool" })]),
    );
  });

  it("checkpoints another delegation round instead of succeeding", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const finalize = vi.fn(async () => undefined);
    const execute = createParentResumeExecutor({
      claim: vi.fn(async () => claimed()),
      resolve: vi.fn(async () => ({
        generate: async () => ({
          text: "Delegating again",
          responseMessages: [
            {
              role: "tool" as const,
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-2",
                  toolName: "delegate_agent",
                  output: {
                    type: "json",
                    value: { status: "accepted", childRunId: "child-2" },
                  },
                },
              ],
            },
            {
              role: "assistant" as const,
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-2",
                  toolName: "delegate_agent",
                },
              ],
            },
          ],
          signal: new AbortController().signal,
          assertActive: vi.fn(),
          fail: vi.fn(async () => undefined),
          finalize,
          checkpoint,
        }),
      })),
      saveAssistant: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    });

    await execute("root-1");

    expect(checkpoint).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
    expect(
      (checkpoint.mock.calls as any[][])[0][0].responseMessages,
    ).toHaveLength(2);
    expect((checkpoint.mock.calls as any[][])[0][0].delegationToolCallIds).toEqual(
      ["call-2"],
    );
  });

  it("accumulates response messages across resumed rounds", async () => {
    const prior = {
      role: "assistant" as const,
      content: [{ type: "text", text: "First round" }],
    };
    const next = claimed();
    next.checkpoint.responseMessages = [prior];
    const checkpoint = vi.fn(async () => undefined);
    const execute = createParentResumeExecutor({
      claim: vi.fn(async () => next),
      resolve: vi.fn(async () => ({
        generate: async () => ({
          text: "Second round",
          responseMessages: [
            {
              role: "tool" as const,
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-2",
                  toolName: "delegate_agent",
                  output: {
                    type: "json",
                    value: { status: "accepted", childRunId: "child-2" },
                  },
                },
              ],
            },
            {
              role: "assistant" as const,
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-2",
                  toolName: "delegate_agent",
                },
              ],
            },
          ],
          signal: new AbortController().signal,
          assertActive: vi.fn(),
          fail: vi.fn(async () => undefined),
          finalize: vi.fn(async () => undefined),
          checkpoint,
        }),
      })),
      saveAssistant: vi.fn(async () => undefined),
      fail: vi.fn(async () => undefined),
    });

    await execute("root-1");

    expect((checkpoint.mock.calls as any[][])[0][0].responseMessages).toEqual([
      prior,
      expect.objectContaining({ role: "tool" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
  });

  it.each(["CANCELLED", "TIMED_OUT"])(
    "does not save or finalize after generation stops with %s",
    async (reason) => {
      const saveAssistant = vi.fn(async () => undefined);
      const finalize = vi.fn(async () => undefined);
      const checkpoint = vi.fn(async () => undefined);
      const fail = vi.fn(async () => undefined);
      const generationFail = vi.fn(async () => undefined);
      const execute = createParentResumeExecutor({
        claim: vi.fn(async () => claimed()),
        resolve: vi.fn(async () => ({
          generate: async () => ({
            text: "must not persist",
            responseMessages: [
              {
                role: "assistant" as const,
                content: [{ type: "text", text: "must not persist" }],
              },
            ],
            signal: AbortSignal.abort(new Error(reason)),
            assertActive() {
              throw new Error(reason);
            },
            fail: generationFail,
            finalize,
            checkpoint,
          }),
        })),
        saveAssistant,
        fail,
      });

      await execute("root-1");

      expect(saveAssistant).not.toHaveBeenCalled();
      expect(finalize).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(generationFail).toHaveBeenCalledOnce();
      expect(fail).not.toHaveBeenCalled();
    },
  );
});
