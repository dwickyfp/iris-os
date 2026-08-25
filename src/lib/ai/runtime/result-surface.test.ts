import { describe, expect, test } from "vitest";
import {
  type ResultSource,
  ResultSurfaceManager,
  type ResultSurfaceStore,
} from "./result-surface";

class MemoryResultStore implements ResultSurfaceStore {
  readonly sources = new Map<string, ResultSource>();

  async put(source: ResultSource) {
    this.sources.set(source.id, structuredClone(source));
    return {
      key: `results/${source.id}`,
      uri: `memory://results/${source.id}`,
    };
  }
}

const ownership = {
  userId: "user-1",
  runId: "run-1",
  workspaceId: "workspace-1",
  taskId: "task-1",
  agentId: "agent-1",
};
const provenance = [
  {
    sourceId: "tool-call-1",
    sourceType: "capability-result",
    metadata: { attempt: 2 },
  },
];

function source(id: string, content: string, mediaType?: string): ResultSource {
  return {
    id,
    content,
    mediaType,
    ownership,
    trust: "untrusted",
    provenance,
  };
}

function manager(store: MemoryResultStore) {
  return new ResultSurfaceManager(store, {
    thresholds: {
      inline: { maxBytes: 20, maxTokens: 5 },
      pruned: { maxBytes: 60, maxTokens: 15 },
      structuredSummary: { maxBytes: 160, maxTokens: 40 },
    },
    estimateTokens: (content) =>
      Math.ceil(new TextEncoder().encode(content).length / 4),
  });
}

describe("ResultSurfaceManager", () => {
  test.each([
    ["small", "a".repeat(20), "inline"],
    ["medium", "b".repeat(60), "pruned"],
    ["large", "c".repeat(160), "structured-summary"],
    ["huge", "d".repeat(161), "reference"],
  ] as const)("projects a %s result as %s", async (id, content, mode) => {
    const store = new MemoryResultStore();
    const result = await manager(store).project(source(id, content));

    expect(result.mode).toBe(mode);
    expect(result.ref).toMatchObject({
      id,
      key: `results/${id}`,
      byteLength: content.length,
      ownership,
      trust: "untrusted",
      provenance,
    });
    expect(store.sources.get(id)).toEqual(source(id, content));
  });

  test("uses either byte or token pressure to cross a threshold", async () => {
    const store = new MemoryResultStore();
    const result = await new ResultSurfaceManager(store, {
      thresholds: {
        inline: { maxBytes: 100, maxTokens: 1 },
        pruned: { maxBytes: 200, maxTokens: 2 },
        structuredSummary: { maxBytes: 300, maxTokens: 3 },
      },
      estimateTokens: () => 2,
    }).project(source("token-pressure", "short"));

    expect(result.mode).toBe("pruned");
  });

  test("prunes deterministic head and tail content without changing the source", async () => {
    const store = new MemoryResultStore();
    const input = source("pruned", "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    const projector = new ResultSurfaceManager(store, {
      thresholds: {
        inline: { maxBytes: 32, maxTokens: 8 },
        pruned: { maxBytes: 100, maxTokens: 25 },
        structuredSummary: { maxBytes: 200, maxTokens: 50 },
      },
      estimateTokens: () => 9,
    });

    const first = await projector.project(input);
    const second = await projector.project(input);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mode: "pruned",
      content: "012\n\n[... result pruned ...]\n\nYZ",
      omittedBytes: 31,
    });
    expect(store.sources.get(input.id)?.content).toBe(input.content);
  });

  test("produces a deterministic structured JSON summary", async () => {
    const store = new MemoryResultStore();
    const content = JSON.stringify({
      zebra: [1, 2, 3],
      alpha: true,
      nested: {},
    });
    const result = await new ResultSurfaceManager(store, {
      thresholds: {
        inline: { maxBytes: 1, maxTokens: 1 },
        pruned: { maxBytes: 2, maxTokens: 2 },
        structuredSummary: { maxBytes: 1_000, maxTokens: 1_000 },
      },
    }).project(source("json", content, "application/json"));

    expect(result).toMatchObject({
      mode: "structured-summary",
      summary: {
        format: "result-summary-v1",
        source: { mediaType: "application/json" },
        structure: {
          type: "object",
          keys: ["alpha", "nested", "zebra"],
          keyCount: 3,
        },
      },
    });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  test.each(["trusted", "untrusted", "mixed"] as const)(
    "preserves %s trust and ownership on the surface and reference",
    async (trust) => {
      const store = new MemoryResultStore();
      const input = { ...source(trust, "result"), trust };
      const result = await manager(store).project(input);

      expect(result).toMatchObject({ ownership, trust, provenance });
      expect(result.ref).toMatchObject({ ownership, trust, provenance });
      expect(store.sources.get(trust)).toEqual(input);
    },
  );
});
