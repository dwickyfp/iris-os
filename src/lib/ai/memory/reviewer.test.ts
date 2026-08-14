import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  getMemoryCuratorMode,
  MemoryOperationBatchSchema,
} from "./reviewer";
import { runMemoryReviewAgent } from "./review-agent";

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

describe("agentic memory reviewer", () => {
  it("defaults rollout to shadow and accepts explicit modes", () => {
    expect(getMemoryCuratorMode({})).toBe("shadow");
    expect(getMemoryCuratorMode({ IRIS_MEMORY_CURATOR_MODE: "write" })).toBe(
      "write",
    );
    expect(getMemoryCuratorMode({ IRIS_MEMORY_CURATOR_MODE: "invalid" })).toBe(
      "shadow",
    );
  });

  it("accepts an atomic partial-correction batch", () => {
    const result = MemoryOperationBatchSchema.safeParse({
      operations: [
        {
          action: "supersede",
          targetId: "11111111-1111-4111-8111-111111111111",
          explicitCurrentCorrection: true,
          evidenceQuote: "aku sudah tidak suka jus jambu",
          reason: "Explicit current correction",
          confidence: 0.96,
          replacements: [
            {
              kind: "preference",
              content: "User suka susu",
              topicKey: "preferences.food-drink",
              entities: ["susu"],
            },
            {
              kind: "preference",
              content: "User tidak suka jus jambu",
              topicKey: "preferences.food-drink",
              entities: ["jus jambu"],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("exposes only search and atomic commit tools to the reviewer", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: {
        content: [{ type: "text", text: "Nothing durable to save." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      },
    });
    const search = vi.fn(async () => []);
    const commit = vi.fn(async () => ({ stats: {}, memoryIds: [] }));

    await runMemoryReviewAgent({
      transcript: [
        { role: "user", content: "aku suka minuman apa?" },
        { role: "assistant", content: "Kamu belum memberitahuku." },
      ],
      scopes: [{ scopeType: "global", scopeId: null }],
      mode: "shadow",
      dependencies: { model, search, commit },
    });

    expect(search).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(
      model.doGenerateCalls[0].tools?.map((candidate) => candidate.name),
    ).toEqual(["search_memory", "commit_memory_operations"]);
  });
});
