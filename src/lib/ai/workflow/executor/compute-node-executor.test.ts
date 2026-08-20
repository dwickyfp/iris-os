import { describe, expect, it, vi } from "vitest";
import { NodeKind, type ComputeNodeData } from "../workflow.interface";
import { computeNodeExecutor } from "./node-executor";

vi.mock("server-only", () => ({}));
vi.mock("lib/ai/mcp/mcp-manager", () => ({ mcpClientsManager: {} }));

const node: ComputeNodeData = {
  id: "compute",
  name: "Compute",
  kind: NodeKind.Compute,
  language: "python",
  code: 'output = {"doubled": inputs["value"] * 2}',
  timeoutMs: 2500,
  inputBindings: [
    {
      name: "value",
      source: { nodeId: "input", path: ["value"] },
      schema: { type: "number" },
    },
  ],
  outputSchema: {
    type: "object",
    properties: { doubled: { type: "number" } },
    required: ["doubled"],
  },
};

function runtime(stdout: string) {
  const executePython = vi.fn(async () => ({
    executionId: "execution-1",
    exitCode: 0,
    stdout,
    stderr: "",
    durationMs: 10,
    files: [],
    artifacts: [{ id: "artifact-1" }],
  }));
  const signal = new AbortController().signal;
  return {
    executePython,
    input: {
      node,
      state: { getOutput: vi.fn(() => 4) } as any,
      context: {
        runId: "run-1",
        userId: "user-1",
        workspaceId: "workspace-1",
        signal,
        services: {
          sandbox: {
            manager: { executePython } as any,
            profile: { id: "profile-1" } as any,
            maxComputeMs: 5_000,
          },
        },
      },
    },
  };
}

describe("computeNodeExecutor", () => {
  it("resolves typed inputs and delegates Python execution to SandboxManager", async () => {
    const testRuntime = runtime(
      'user log\n__IRIS_WORKFLOW_OUTPUT__:{"doubled":8}\n',
    );

    await expect(computeNodeExecutor(testRuntime.input)).resolves.toEqual({
      input: {
        bindings: { value: 4 },
        executionId: "execution-1",
        artifacts: [{ id: "artifact-1" }],
      },
      output: { doubled: 8 },
    });
    expect(testRuntime.executePython).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          runId: "run-1",
          userId: "user-1",
          workspaceId: "workspace-1",
        },
        request: expect.objectContaining({ timeoutMs: 2500 }),
        signal: testRuntime.input.context.signal,
      }),
    );
    const request = (testRuntime.executePython.mock.calls as any[][])[0]?.[0]
      ?.request;
    expect(request).toBeDefined();
    expect(request.code).toContain("<workflow-compute>");
    expect(request.code).not.toContain("subprocess");
  });

  it("rejects output that does not match the expected schema", async () => {
    const testRuntime = runtime('__IRIS_WORKFLOW_OUTPUT__:{"doubled":"eight"}');
    await expect(computeNodeExecutor(testRuntime.input)).rejects.toThrow();
  });

  it("requires scoped execution context", async () => {
    await expect(
      computeNodeExecutor({ node, state: {} as any }),
    ).rejects.toThrow("WORKFLOW_COMPUTE_CONTEXT_REQUIRED");
  });
});
