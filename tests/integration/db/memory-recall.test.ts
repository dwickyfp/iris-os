import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;

vi.mock("server-only", () => ({}));

const client = new Client({ connectionString });
type MemoryGraphRepository = typeof import("lib/db/pg/repositories/memory-graph-repository.pg")["pgMemoryGraphRepository"];
type MemoryReviewRepository = typeof import("lib/db/pg/repositories/memory-review-repository.pg")["pgMemoryReviewRepository"];
type MemoryService = typeof import("lib/ai/memory/service");
let repository: MemoryGraphRepository;
let reviewRepository: MemoryReviewRepository;
let service: MemoryService;
let userId: string;
let threadId: string;
let messageId: string;

async function insertClaim(
  content: string,
  options: { confidence?: number; ageMs?: number } = {},
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO user_memory
      (id, user_id, kind, content, confidence, status, provenance,
       created_at, updated_at)
     VALUES ($1, $2, 'preference', $3, $4, 'active', 'manual',
             NOW() - ($5 || ' milliseconds')::interval,
             NOW() - ($5 || ' milliseconds')::interval)`,
    [id, userId, content, options.confidence ?? 90, String(options.ageMs ?? 0)],
  );
  return id;
}

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
  userId = randomUUID();
  threadId = randomUUID();
  messageId = `message-${randomUUID()}`;
  await client.query(
    `INSERT INTO "user" (id, name, email, password)
     VALUES ($1, 'Recall User', $2, 'hash')`,
    [userId, `recall-${userId}@example.test`],
  );
  await client.query(
    `INSERT INTO chat_thread (id, title, user_id)
     VALUES ($1, 'Recall', $2)`,
    [threadId, userId],
  );
  await client.query(
    `INSERT INTO chat_message (id, thread_id, role, parts)
     VALUES ($1, $2, 'user', $3::json[])`,
    [messageId, threadId, [`{"type":"text","text":"aku suka jus jambu"}`]],
  );
  await client.query(
    `INSERT INTO chat_message_search (message_id, thread_id, user_id, content)
     VALUES ($1, $2, $3, 'aku suka jus jambu dan teh melati')`,
    [messageId, threadId, userId],
  );
  repository = (
    await import("lib/db/pg/repositories/memory-graph-repository.pg")
  ).pgMemoryGraphRepository;
  reviewRepository = (
    await import("lib/db/pg/repositories/memory-review-repository.pg")
  ).pgMemoryReviewRepository;
  service = await import("lib/ai/memory/service");
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("keyword-only memory recall", () => {
  test("ranks lexical matches with ts_rank and confidence/updatedAt tiebreakers", async () => {
    const strong = await insertClaim("User suka jus jambu dan jus mangga", {
      confidence: 95,
    });
    const weak = await insertClaim("User pernah menyebut jus jambu", {
      confidence: 50,
    });
    await insertClaim("User suka susu", { confidence: 99 });
    const result = await repository.hybridRecall(userId, "jus jambu", 8, {
      scopeType: "global",
      scopeId: null,
    });
    const ids = result.nodes.map((node) => node.id);
    expect(ids).toContain(strong);
    expect(ids).toContain(weak);
    expect(ids.indexOf(strong)).toBeLessThan(ids.indexOf(weak));
    expect(ids).not.toContain(
      (
        await client.query(
          `SELECT id FROM user_memory WHERE user_id = $1 AND content = 'User suka susu'`,
          [userId],
        )
      ).rows[0].id,
    );
  });

  test("keyword mode skips semantic retrieval and embedding model calls", async () => {
    process.env.IRIS_MEMORY_RECALL_MODE = "keyword";
    const models = await import("lib/ai/models");
    const modelSpy = vi
      .spyOn(models.customModelProvider, "getEmbeddingModel")
      .mockResolvedValue(undefined);
    try {
      const claim = await insertClaim("User suka teh melati");
      const recall = await repository.hybridRecall(userId, "teh melati", 8, {
        scopeType: "global",
        scopeId: null,
      });
      expect(recall.nodes.some((node) => node.id === claim)).toBe(true);

      const candidates = await reviewRepository.findCandidates({
        userId,
        query: "teh melati",
        scopes: [{ scopeType: "global", scopeId: null }],
      });
      expect(candidates.some((candidate) => candidate.id === claim)).toBe(true);

      const overview = await repository.overview(userId);
      expect(overview.degradedSemanticSearch).toBe(true);

      expect(modelSpy).not.toHaveBeenCalled();
    } finally {
      modelSpy.mockRestore();
      delete process.env.IRIS_MEMORY_RECALL_MODE;
    }
  });

  test("chat message search uses ts_rank ordering", async () => {
    const otherThreadId = randomUUID();
    await client.query(
      `INSERT INTO chat_thread (id, title, user_id)
       VALUES ($1, 'Other Recall', $2)`,
      [otherThreadId, userId],
    );
    const exactId = `message-${randomUUID()}`;
    await client.query(
      `INSERT INTO chat_message (id, thread_id, role, parts)
       VALUES ($1, $2, 'user', $3::json[])`,
      [exactId, otherThreadId, [`{"type":"text","text":"jus jambu"}`]],
    );
    await client.query(
      `INSERT INTO chat_message_search
        (message_id, thread_id, user_id, content, created_at)
       VALUES ($1, $2, $3, 'jus jambu jus jambu', NOW() - interval '1 hour')`,
      [exactId, otherThreadId, userId],
    );
    const context = await service.buildMemoryContext(userId, "jus jambu");
    expect(context.used).toBe(true);
    expect(context.prompt).toContain("jus jambu");
  });
});
