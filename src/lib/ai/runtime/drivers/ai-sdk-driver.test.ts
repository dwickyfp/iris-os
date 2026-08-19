import { beforeEach, describe, expect, test, vi } from "vitest";
import { createToolLoopAgent } from "../../agent/create-tool-loop-agent";
import { AiSdkExecutionDriver } from "./ai-sdk-driver";

vi.mock("../../agent/create-tool-loop-agent", () => ({
  createToolLoopAgent: vi.fn(),
}));

describe("AiSdkExecutionDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("constructs and generates with the native tool-loop agent", async () => {
    const result = { text: "complete", usage: { totalTokens: 12 } };
    const generate = vi.fn(async () => result);
    vi.mocked(createToolLoopAgent).mockReturnValue({ generate } as never);
    const agent = { instructions: "Handle the goal" } as never;
    const execution = { prompt: "Do the work", timeout: 1_000 } as never;

    await expect(
      new AiSdkExecutionDriver().generate({ agent, execution }),
    ).resolves.toBe(result);

    expect(createToolLoopAgent).toHaveBeenCalledWith(agent);
    expect(generate).toHaveBeenCalledWith(execution);
  });

  test("returns the native stream result without adapting it", async () => {
    const result = {
      consumeStream: vi.fn(),
      toUIMessageStream: vi.fn(),
    };
    const stream = vi.fn(async () => result);
    vi.mocked(createToolLoopAgent).mockReturnValue({ stream } as never);
    const agent = { instructions: "Handle the goal" } as never;
    const execution = { messages: [], abortSignal: undefined } as never;

    await expect(
      new AiSdkExecutionDriver().stream({ agent, execution }),
    ).resolves.toBe(result);

    expect(createToolLoopAgent).toHaveBeenCalledWith(agent);
    expect(stream).toHaveBeenCalledWith(execution);
  });
});
