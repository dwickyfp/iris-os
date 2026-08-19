import type { UIMessage } from "ai";
import { describe, expect, test, vi } from "vitest";
import { ContextPlanner } from "../context-planner";
import { ContextEngine } from "./context-engine";

function message(id: string, role: "user" | "assistant", text: string) {
  return { id, role, parts: [{ type: "text", text }] } as UIMessage;
}

describe("ContextEngine", () => {
  test("resolves sources with provenance and explicit trust boundaries", async () => {
    const engine = new ContextEngine({
      planner: new ContextPlanner(),
      loadSummary: vi.fn(),
      summarize: vi.fn(),
      saveSummary: vi.fn(),
    });

    const result = await engine.resolve({
      currentRequest: "do the thing",
      sources: [
        { id: "workspace-1", kind: "workspace", content: "workspace rule", trust: "trusted", priority: 90 },
        { id: "remote-1", kind: "remote_observation", content: "remote claim", trust: "untrusted", priority: 10 },
      ],
    });

    expect(result.instructions).toContain("workspace rule");
    expect(result.sourceRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "workspace-1", trust: "trusted", included: true }),
      expect.objectContaining({ id: "remote-1", trust: "untrusted", included: true }),
    ]));
    expect(result.trustBoundaries).toContain("remote-1:untrusted");
  });

  test("truncates deterministically by priority", async () => {
    const engine = new ContextEngine({
      planner: new ContextPlanner(),
      loadSummary: vi.fn(),
      summarize: vi.fn(),
      saveSummary: vi.fn(),
    });
    const input = {
      contextWindow: 20,
      sources: [
        { id: "low", kind: "resource" as const, content: "l".repeat(100), priority: 1 },
        { id: "high", kind: "task" as const, content: "h".repeat(20), priority: 10 },
      ],
    };
    const first = await engine.resolve(input);
    const second = await engine.resolve(input);
    expect(first).toEqual(second);
    expect(first.truncatedSources).toContain("low");
    expect(first.sourceRecords.find((record) => record.id === "high")?.included).toBe(true);
  });

  test("composes the planner and preserves its context precedence", () => {
    const engine = new ContextEngine({
      planner: new ContextPlanner(10_000),
      loadSummary: vi.fn(),
      summarize: vi.fn(),
      saveSummary: vi.fn(),
    });

    const result = engine.plan({
      currentRequest: "request",
      task: "task",
      workspaceInstructions: "workspace",
      conversation: "conversation",
    });

    expect(result.sections.map((section) => section.source)).toEqual([
      "current_request",
      "task",
      "workspace_instructions",
      "conversation",
    ]);
  });

  test("returns original messages and diagnostics below the compaction budget", async () => {
    const loadSummary = vi.fn();
    const summarize = vi.fn();
    const saveSummary = vi.fn();
    const messages = [message("m1", "user", "Keep this message")];
    const engine = new ContextEngine({
      planner: new ContextPlanner(),
      loadSummary,
      summarize,
      saveSummary,
    });

    const result = await engine.compact({
      threadId: "thread-1",
      messages,
      contextWindow: 10_000,
    });

    expect(result.messages).toBe(messages);
    expect(result.provenance).toEqual([
      { source: "conversation", messageIds: ["m1"] },
    ]);
    expect(result.diagnostics).toMatchObject({
      compacted: false,
      retainedMessages: 1,
      summarizedMessages: 0,
    });
    expect(loadSummary).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(saveSummary).not.toHaveBeenCalled();
  });

  test("characterizes rolling compaction without a database", async () => {
    const loadSummary = vi.fn(async () => "Earlier summary");
    const summarize = vi.fn(async () => "New summary");
    const saveSummary = vi.fn(async () => undefined);
    const messages = [
      message("m1", "user", "A".repeat(120)),
      message("m2", "assistant", "B".repeat(120)),
      message("m3", "user", "latest"),
    ];
    const engine = new ContextEngine({
      planner: new ContextPlanner(),
      loadSummary,
      summarize,
      saveSummary,
    });

    const result = await engine.compact({
      threadId: "thread-1",
      messages,
      contextWindow: 100,
    });

    expect(result.messages[0]).toEqual({
      id: "context-summary-thread-1",
      role: "system",
      parts: [{ type: "text", text: "Conversation summary:\nNew summary" }],
    });
    expect(result.messages.at(-1)?.id).toBe("m3");
    expect(loadSummary).toHaveBeenCalledWith("thread-1");
    expect(summarize).toHaveBeenCalledWith({
      instructions:
        "Summarize this chat context factually and compactly. Preserve user goals, decisions, constraints, and unresolved questions. Do not mention that you are summarizing.",
      prompt: expect.stringContaining(
        "Previous summary:\nEarlier summary\n\nConversation to compact:\n",
      ),
    });
    expect(saveSummary).toHaveBeenCalledWith("thread-1", "New summary");
    expect(result.provenance).toEqual([
      { source: "conversation_summary", messageIds: ["m1", "m2"] },
      { source: "conversation", messageIds: ["m3"] },
    ]);
    expect(result.diagnostics).toMatchObject({
      compacted: true,
      retainedMessages: 1,
      summarizedMessages: 2,
      budget: 85,
    });
  });
});
