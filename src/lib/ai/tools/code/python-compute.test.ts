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
});
