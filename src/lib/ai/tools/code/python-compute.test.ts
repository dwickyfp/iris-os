import { describe, expect, it, vi } from "vitest";
import { createPythonComputeTool } from "./python-compute";

describe("python_compute", () => {
  it("exposes compute inputs without shell or lifecycle controls", async () => {
    const executePython = vi.fn(async () => ({ stdout: "ok" }));
    const tool = createPythonComputeTool({
      manager: { executePython } as any,
      profile: {} as any,
      maxComputeMs: 5_000,
    });
    const schema = tool.inputSchema as any;
    const shape =
      typeof schema._def?.shape === "function"
        ? schema._def.shape()
        : schema._def?.shape;
    const properties = Object.keys(shape);

    expect(properties).toEqual([
      "code",
      "inputArtifacts",
      "outputPaths",
      "timeoutMs",
      "packages",
    ]);
    expect(properties).not.toContain("command");
    expect(properties).not.toContain("instanceId");
    expect(properties).not.toContain("destroy");
    expect(() =>
      schema.parse({ code: "print('ok')", packages: ["requests==2.32.5"] }),
    ).toThrow("Dynamic package installation is disabled");
  });

  it("returns downloadable artifact links without exposing storage keys", async () => {
    const executePython = vi.fn(async () => ({
      executionId: "execution-1",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      files: [],
      artifacts: [
        {
          artifactId: "0f98f5c9-45f1-4a5f-88e4-56724ab11701",
          storageKey: "artifacts/internal-secret.bin",
          filename: "project.zip",
          mediaType: "application/zip",
          size: 12,
          sha256: "a".repeat(64),
          relativePath: "output/project.zip",
        },
      ],
    }));
    const tool = createPythonComputeTool({
      manager: { executePython } as any,
      profile: {} as any,
      maxComputeMs: 5_000,
    });
    const result = (await tool.execute!(
      { code: "pass", outputPaths: ["output/project.zip"] },
      { context: { runId: "run-1", userId: "user-1" }, toolCallId: "call-1" } as any,
    )) as any;

    expect(result.artifacts).toEqual([
      {
        artifactId: "0f98f5c9-45f1-4a5f-88e4-56724ab11701",
        filename: "project.zip",
        mediaType: "application/zip",
        size: 12,
        relativePath: "output/project.zip",
        downloadUrl: "/api/artifacts/0f98f5c9-45f1-4a5f-88e4-56724ab11701",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("internal-secret.bin");
  });
});
