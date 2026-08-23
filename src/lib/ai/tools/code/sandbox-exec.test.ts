import { describe, expect, it, vi } from "vitest";
import { createSandboxExecTool } from "./sandbox-exec";

describe("sandbox_exec", () => {
  it("executes allowlisted commands through the sandbox manager", async () => {
    const execute = vi.fn(async () => ({
      executionId: "execution-1",
      exitCode: 0,
      stdout: "1 passed",
      stderr: "",
      durationMs: 5,
    }));
    const tool = createSandboxExecTool({
      manager: { execute } as any,
      profile: { executionTimeoutMs: 60_000 } as any,
      maxComputeMs: 300_000,
    });
    const result = await tool.execute!(
      {
        executable: "pytest",
        args: ["-q", "/workspace/work/project"],
        cwd: "/workspace/work",
        timeoutMs: 120_000,
      },
      {
        context: { runId: "run-1", userId: "user-1" },
        toolCallId: "call-1",
      } as any,
    );

    expect(execute).toHaveBeenCalledWith({
      scope: { runId: "run-1", userId: "user-1" },
      profile: { executionTimeoutMs: 60_000 },
      request: {
        executable: "pytest",
        args: ["-q", "/workspace/work/project"],
        cwd: "/workspace/work",
        env: undefined,
        timeoutMs: 120_000,
      },
      maxComputeMs: 300_000,
      signal: undefined,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "1 passed" });
  });

  it("rejects shell lifecycle and Docker controls at the schema boundary", () => {
    const tool = createSandboxExecTool({
      manager: {} as any,
      profile: {} as any,
      maxComputeMs: 60_000,
    });
    const schema = tool.inputSchema as any;
    for (const executable of ["sh", "bash", "docker", "runsc", "sudo"]) {
      expect(() => schema.parse({ executable, args: [] })).toThrow();
    }
  });
});
