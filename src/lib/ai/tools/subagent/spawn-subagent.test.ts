import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { SpawnSubagentToolName } from "lib/ai/tools";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { subagentToolTimeoutMs } from "./spawn-subagent";
import { createSpawnSubagentTool } from "./spawn-subagent";
import {
  SUBAGENT_TOOL_ALLOWLIST,
  extractSubagentProgressText,
  isSpawnSubagentOutput,
  selectSubagentTools,
} from "./definitions";
import type { AgentRuntimeContext } from "../../agent/runtime-context";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function textStreamResult(text: string): any {
  return {
    stream: simulateReadableStream({
      initialDelayInMs: 1,
      chunkDelayInMs: 1,
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: text },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          finishReason: { unified: "stop", raw: "stop" },
          usage,
        },
      ] as any,
    }),
  };
}

function toolCallThenTextStream(
  toolName: string,
  input: unknown,
  text: string,
): any[] {
  return [
    {
      stream: simulateReadableStream({
        initialDelayInMs: 1,
        chunkDelayInMs: 1,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "tool-input-start", id: "tc1", toolName },
          {
            type: "tool-input-delta",
            id: "tc1",
            delta: JSON.stringify(input),
          },
          { type: "tool-input-end", id: "tc1" },
          {
            type: "tool-call",
            toolCallId: "tc1",
            toolName,
            input: JSON.stringify(input),
          },
          {
            type: "finish",
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
          },
        ] as any,
      }),
    },
    textStreamResult(text),
  ];
}

function runtimeContext(): AgentRuntimeContext {
  return {
    requestId: "request-1",
    runId: "run-1",
    userId: "user-1",
    agentType: "base",
    toolMode: "auto",
    approvalPolicy: "never",
    skills: [],
  } as AgentRuntimeContext;
}

function artifactService() {
  return {
    create: vi.fn(async (input: { filename: string; content: string }) => ({
      artifactId: "art-1",
      filename: input.filename,
      mediaType: "text/markdown",
      size: input.content.length,
    })),
  };
}

function makeTool({
  model,
  artifacts = artifactService(),
  parentTools = {},
}: {
  model: MockLanguageModelV3;
  artifacts?: ReturnType<typeof artifactService>;
  parentTools?: Record<string, any>;
}) {
  return createSpawnSubagentTool({
    model,
    runtimeContext: runtimeContext(),
    artifacts,
    parentTools,
  });
}

const INPUT = {
  subagent: "research",
  title: "Test Title",
  task: "research iris-os",
} as const;

async function runToolExecute(instance: any, abortSignal?: AbortSignal) {
  const outputs: unknown[] = [];
  const generator = (instance.execute as any)(
    { ...INPUT },
    { toolCallId: "call-1", messages: [], abortSignal },
  );
  let result = await generator.next();
  while (!result.done) {
    outputs.push(result.value);
    result = await generator.next();
  }
  return { preliminary: outputs, final: result.value };
}

describe("spawn_subagent tool", () => {
  it("streams preliminary UIMessages and returns a structured final output", async () => {
    const model = new MockLanguageModelV3({
      doStream: [textStreamResult("## Findings\n\nIris is modular.")],
    });
    const artifacts = artifactService();
    const instance = makeTool({ model, artifacts });

    const { preliminary, final } = await runToolExecute(instance);

    expect(preliminary.length).toBeGreaterThan(0);
    for (const output of preliminary) {
      expect((output as { parts?: unknown[] }).parts).toBeInstanceOf(Array);
      expect(isSpawnSubagentOutput(output)).toBe(false);
    }
    expect(isSpawnSubagentOutput(final)).toBe(true);
    expect(final).toMatchObject({
      status: "completed",
      subagent: "research",
      task: "research iris-os",
      title: "Test Title",
      report: "## Findings\n\nIris is modular.",
      artifact: {
        artifactId: "art-1",
        filename: "test-title.md",
        mediaType: "text/markdown",
      },
    });
    expect(artifacts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "## Findings\n\nIris is modular.",
        filename: "test-title.md",
        mediaType: "text/markdown",
        userId: "user-1",
        runId: "run-1",
      }),
    );
  });

  it("keeps the final output when artifact storage fails", async () => {
    const model = new MockLanguageModelV3({
      doStream: [textStreamResult("report body")],
    });
    const artifacts = {
      create: vi.fn(async () => {
        throw new Error("storage down");
      }),
    };
    const instance = makeTool({ model, artifacts: artifacts as any });

    const { final } = await runToolExecute(instance);

    expect(isSpawnSubagentOutput(final)).toBe(true);
    expect(final).toMatchObject({
      status: "completed",
      report: "report body",
      artifact: null,
    });
  });

  it("executes allowlisted parent tools inside the subagent", async () => {
    const webSearchExecute = vi.fn(async () => "search results");
    const model = new MockLanguageModelV3({
      doStream: toolCallThenTextStream(
        "webSearch",
        { query: "iris-os" },
        "final report",
      ),
    });
    const instance = makeTool({
      model,
      parentTools: {
        webSearch: tool({
          description: "search",
          inputSchema: z.object({ query: z.string() }),
          execute: webSearchExecute,
        }),
      },
    });

    const { final } = await runToolExecute(instance);

    expect(webSearchExecute).toHaveBeenCalledTimes(1);
    expect(final).toMatchObject({ report: "final report" });
  });

  it("does not pass tools outside the allowlist to the subagent", async () => {
    const httpExecute = vi.fn(async () => "fetched");
    const model = new MockLanguageModelV3({
      doStream: toolCallThenTextStream("http", { url: "https://x" }, "done"),
    });
    const instance = makeTool({
      model,
      parentTools: {
        http: tool({
          description: "http",
          inputSchema: z.object({ url: z.string() }),
          execute: httpExecute,
        }),
      },
    });

    const { final } = await runToolExecute(instance);

    expect(httpExecute).not.toHaveBeenCalled();
    expect(final).toMatchObject({ status: "completed" });
  });

  it("maps the final output to a concise model-facing text summary", async () => {
    const model = new MockLanguageModelV3({
      doStream: [textStreamResult("the report")],
    });
    const instance = makeTool({ model });

    const { final } = await runToolExecute(instance);

    const modelOutput = (instance as any).toModelOutput({
      toolCallId: "call-1",
      input: INPUT,
      output: final,
    });
    expect(modelOutput).toMatchObject({ type: "text" });
    expect(modelOutput.value).toContain("the report");
  });

  it("extracts progress text and propagates abort to the subagent", async () => {
    const message = {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: "partial findings" },
      ],
    } as any;
    expect(extractSubagentProgressText(message)).toBe("partial findings");
    expect(extractSubagentProgressText({ id: "m2", parts: [] } as any)).toBe("");

    const model = new MockLanguageModelV3({
      doStream: [textStreamResult("the report")],
    });
    const instance = makeTool({ model });
    const controller = new AbortController();

    await runToolExecute(instance, controller.signal);

    const abortSignal = model.doStreamCalls[0]?.abortSignal;
    expect(abortSignal).toBeDefined();
    expect(abortSignal?.aborted).toBe(false);

    controller.abort();
    expect(abortSignal?.aborted).toBe(true);
  });
});

describe("selectSubagentTools", () => {
  it("intersects parent tools with the read-only allowlist", () => {
    const webSearch = {} as any;
    const webContent = {} as any;
    const http = {} as any;
    const selected = selectSubagentTools({
      webSearch,
      webContent,
      http,
      [SpawnSubagentToolName]: {} as any,
    });
    expect(Object.keys(selected).sort()).toEqual(
      [...SUBAGENT_TOOL_ALLOWLIST].sort(),
    );
    expect(selected.webSearch).toBe(webSearch);
    expect(selected.webContent).toBe(webContent);
  });

  it("returns an empty toolset when the parent has no allowlisted tools", () => {
    expect(selectSubagentTools({ http: {} as any })).toEqual({});
  });
});

describe("subagentToolTimeoutMs", () => {
  it("defaults to 120 seconds", () => {
    expect(subagentToolTimeoutMs({})).toBe(120_000);
  });

  it("clamps the env override between 30s and 300s", () => {
    expect(subagentToolTimeoutMs({ AI_SUBAGENT_TIMEOUT_MS: "5000" })).toBe(
      30_000,
    );
    expect(subagentToolTimeoutMs({ AI_SUBAGENT_TIMEOUT_MS: "600000" })).toBe(
      300_000,
    );
    expect(subagentToolTimeoutMs({ AI_SUBAGENT_TIMEOUT_MS: "90000" })).toBe(
      90_000,
    );
    expect(
      subagentToolTimeoutMs({ AI_SUBAGENT_TIMEOUT_MS: "not-a-number" }),
    ).toBe(120_000);
  });
});
