import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("lib/db/pg/db.pg", () => ({
  pgDb: {
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve([]),
      };
      return chain;
    },
  },
}));
vi.mock("lib/db/pg/schema.pg", () => ({
  ChatMessageSearchTable: {
    content: "chat_message_search.content",
    threadId: "chat_message_search.thread_id",
    userId: "chat_message_search.user_id",
    createdAt: "chat_message_search.created_at",
  },
  ChatThreadTable: {
    id: "chat_thread.id",
    userId: "chat_thread.user_id",
    workspaceId: "chat_thread.workspace_id",
  },
}));

const hybridRecall = vi.fn(async (_userId, _query, _limit, scope) => ({
  nodes:
    scope.scopeType === "global"
      ? [
          {
            id: "topic-1",
            type: "topic",
            label: "Preferensi",
            summary: "Aku suka jus jambu",
            detail: null,
          },
          {
            id: "claim-1",
            type: "claim",
            label: "Aku suka jus jambu",
            category: "preference",
          },
        ]
      : [
          {
            id: "topic-1",
            type: "topic",
            label: "Preferensi",
            summary: "Aku suka jus jambu",
            detail: null,
          },
          {
            id: "entity-1",
            type: "entity",
            label: "jus jambu",
          },
        ],
  paths: [],
}));

vi.mock("lib/db/repository", () => ({
  memoryGraphRepository: { hybridRecall },
}));

const { buildMemoryContext, buildRecallQuery, recallMemory } = await import(
  "./service"
);

describe("buildRecallQuery", () => {
  it("keeps a content-rich current message untouched", () => {
    const current = "rekomendasi wisata gunung semiringgini bulan depan";
    expect(buildRecallQuery(current, ["pesan lampau"])).toBe(current);
  });

  it("backfills thin current messages from the most recent prior turn", () => {
    const query = buildRecallQuery("seperti biasa", [
      // newest first; "baru" repeats within the turn and must not duplicate
      "baru pesan paling baru",
      "pesan lebih lama tentang kopi",
    ]);
    expect(query.startsWith("seperti biasa")).toBe(true);
    expect(query.split("baru").length - 1).toBe(1);
    expect(query).toContain("kopi");
  });

  it("returns the current message unchanged when there is no history", () => {
    expect(buildRecallQuery("halo", [])).toBe("halo");
  });
});

describe("recallMemory", () => {
  it("queries every recall scope and deduplicates nodes", async () => {
    hybridRecall.mockClear();
    const result = await recallMemory("user-1", "jus jambu", {
      workspaceId: "ws-1",
    });
    expect(hybridRecall).toHaveBeenCalledTimes(2);
    expect(result.used).toBe(true);
    // topic appears in both scopes but only once
    expect(result.lines.match(/Preferensi/g)?.length).toBe(1);
    expect(result.lines).toContain("Related concept: jus jambu");
  });

  it("reports no memory when nothing was recalled", async () => {
    hybridRecall.mockClear();
    hybridRecall.mockResolvedValue({ nodes: [], paths: [] });
    const result = await recallMemory("user-1", "query", {});
    expect(result.used).toBe(false);
    expect(result.lines).toBe("");
  });
});

describe("buildMemoryContext", () => {
  it("marks the injection prompt as untrusted reference data", async () => {
    hybridRecall.mockResolvedValue({
      nodes: [
        {
          id: "claim-1",
          type: "claim",
          label: "Aku suka jus jambu",
          category: "preference",
        },
      ],
      paths: [],
    });
    const context = await buildMemoryContext("user-1", "jus jambu", {});
    expect(context.used).toBe(true);
    expect(context.prompt).toContain("untrusted reference data");
    expect(context.prompt).toContain("preference: Aku suka jus jambu");
  });
});
