import { describe, expect, test, vi } from "vitest";
import { RunPreparer } from "./run-preparer";

describe("RunPreparer", () => {
  test("uses the same resolved instructions and messages for any caller", async () => {
    const resolve = vi.fn(async (input: any) => ({
      instructions: input.instructions ?? "resolved",
      messages: input.messages ?? [],
      sourceRecords: [],
      estimatedTokens: 0,
      truncatedSources: [],
      trustBoundaries: [],
      provenance: [],
      diagnostics: {
        compacted: false,
        estimatedTokensBefore: 0,
        estimatedTokensAfter: 0,
        budget: 0,
        retainedMessages: 0,
        summarizedMessages: 0,
      },
    }));
    const preparer = new RunPreparer({ resolve });
    const input = { request: "run", instructions: "policy", messages: [] };
    const chat = await preparer.prepare(input);
    const automation = await preparer.prepare(input);
    expect(chat).toEqual(automation);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
