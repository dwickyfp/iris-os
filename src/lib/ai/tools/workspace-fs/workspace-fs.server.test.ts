import { MockLanguageModelV3 } from "ai/test";
import { createToolLoopAgent } from "lib/ai/agent/create-tool-loop-agent";
import type { AgentRuntimeContext } from "lib/ai/agent/runtime-context";
import { WorkspaceFsToolName } from "lib/ai/tools";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileRepository } from "../../workspace-fs/contracts";

vi.mock("server-only", () => ({}));

vi.mock("lib/db/repository", async () => {
  const { createInMemoryWorkspaceFileRepository } = await import(
    "../../workspace-fs/in-memory-repository"
  );
  const repository = createInMemoryWorkspaceFileRepository();
  (globalThis as Record<string, unknown>).__workspaceFsTestRepository =
    repository;
  return { workspaceFileRepository: repository, artifactRepository: {} };
});

vi.mock("lib/file-storage", () => ({ serverFileStorage: {} }));

// The export op copies a workspace file into the artifact subsystem; the real
// ArtifactService uploads through object storage, so the tool test injects a
// fake that records the artifact reference without network I/O.
vi.mock("lib/ai/artifacts", () => ({
  ArtifactService: class {
    async create(input: {
      content: string;
      filename: string;
      mediaType: string;
    }) {
      return {
        artifactId: "artifact-export-1",
        storageKey: `artifacts/${input.filename}`,
        filename: input.filename,
        mediaType: input.mediaType,
        size: Buffer.byteLength(input.content, "utf8"),
        sha256: "a".repeat(64),
      };
    }
  },
}));

async function loadTool() {
  const { createWorkspaceFsTool } = await import("./workspace-fs.server");
  return createWorkspaceFsTool();
}

function runtimeContext(
  overrides: Partial<AgentRuntimeContext> = {},
): AgentRuntimeContext {
  return {
    requestId: "request-1",
    runId: "run-1",
    userId: "user-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    agentType: "base",
    toolMode: "auto",
    approvalPolicy: "never",
    skills: [],
    ...overrides,
  } as AgentRuntimeContext;
}

function textModel(call: { toolCallId: string; input: unknown }) {
  return new MockLanguageModelV3({
    doGenerate: [
      {
        content: [
          {
            type: "tool-call",
            toolCallId: call.toolCallId,
            toolName: WorkspaceFsToolName,
            input: JSON.stringify(call.input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      } as any,
      {
        content: [{ type: "text", text: "done" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      } as any,
    ],
  } as any);
}

async function toolResult(
  instance: any,
  input: unknown,
  context?: unknown,
): Promise<unknown> {
  return await instance.execute(input, {
    toolCallId: "call-1",
    messages: [],
    context,
  });
}

describe("workspace_fs tool through the guarded agent runtime", () => {
  let tool: any;
  beforeAll(async () => {
    tool = await loadTool();
  });

  it("fails closed when no agent runtime context is provided", async () => {
    const result = (await toolResult(tool, {
      op: "read",
      path: "a.txt",
    })) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("REPOSITORY_FAILURE");
  });

  it("derives the workspace scope from the agent runtime context", async () => {
    const write = (await toolResult(
      tool,
      { op: "write", path: "notes/a.md", content: "hello" },
      runtimeContext(),
    )) as { ok: boolean; path: string };

    expect(write.ok).toBe(true);
    const repository = (globalThis as Record<string, any>)
      .__workspaceFsTestRepository as WorkspaceFileRepository;
    const stored = await repository.selectByPath(
      "user-1",
      "workspace:workspace-1",
      "notes/a.md",
    );
    expect(stored?.content).toBe("hello");
  });

  it("keeps task scope separate from workspace scope", async () => {
    await toolResult(
      tool,
      { op: "write", path: "shared.md", content: "task version" },
      runtimeContext({ taskId: "task-1" }),
    );
    const read = (await toolResult(
      tool,
      { op: "read", path: "shared.md" },
      runtimeContext(),
    )) as { ok: boolean };
    expect(read.ok).toBe(false);
  });

  it("writes and reads a file end-to-end through the agent loop", async () => {
    const repository = (globalThis as Record<string, any>)
      .__workspaceFsTestRepository as WorkspaceFileRepository;
    const agent = createToolLoopAgent({
      profile: { type: "base" },
      model: textModel({
        toolCallId: "call-ws-1",
        input: { op: "write", path: "reports/q3.md", content: "# Q3\n" },
      }),
      instructions: "test",
      tools: { [WorkspaceFsToolName]: tool },
      runtimeContext: runtimeContext(),
    });

    // The chat route forwards the agent runtime context as a per-tool
    // toolsContext map in the execution block (see
    // src/app/api/chat/route.ts); the AI SDK resolves each tool's execute
    // options.context as toolsContext[toolName].
    const result = await agent.generate({
      prompt: "write the report",
      toolsContext: { [WorkspaceFsToolName]: runtimeContext() },
    } as any);
    const step = (result as { steps?: any[] }).steps?.[0];
    const toolOutput = (
      step?.content?.find?.(
        (part: any) =>
          part.type === "tool-result" && part.toolName === WorkspaceFsToolName,
      ) ?? {}
    ).output;
    expect(toolOutput).toMatchObject({ ok: true, path: "reports/q3.md" });

    const stored = await repository.selectByPath(
      "user-1",
      "workspace:workspace-1",
      "reports/q3.md",
    );
    expect(stored?.content).toBe("# Q3\n");
    expect(stored?.version).toBe(1);
  });

  it("exports a workspace file as a downloadable artifact link", async () => {
    await toolResult(
      tool,
      { op: "write", path: "reports/export-me.md", content: "# Export\n" },
      runtimeContext(),
    );

    const exported = (await toolResult(
      tool,
      { op: "export", path: "reports/export-me.md" },
      runtimeContext(),
    )) as {
      ok: boolean;
      artifactId: string;
      filename: string;
      downloadUrl: string;
      size: number;
    };

    expect(exported).toMatchObject({
      ok: true,
      artifactId: "artifact-export-1",
      filename: "export-me.md",
      downloadUrl: "/api/artifacts/artifact-export-1",
    });
    expect(exported.size).toBe(Buffer.byteLength("# Export\n", "utf8"));
  });

  it("returns PATH_NOT_FOUND when exporting a missing file", async () => {
    const missing = (await toolResult(
      tool,
      { op: "export", path: "reports/nope.md" },
      runtimeContext(),
    )) as { ok: boolean; error: string };
    expect(missing).toMatchObject({ ok: false, error: "PATH_NOT_FOUND" });
  });
});
