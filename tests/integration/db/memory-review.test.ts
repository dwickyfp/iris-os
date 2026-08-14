import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;

const client = new Client({ connectionString });
let repository: typeof import("lib/db/pg/repositories/memory-review-repository.pg").pgMemoryReviewRepository;
let userId: string;
let threadId: string;

async function insertRun(jobKey: string) {
  const runId = randomUUID();
  await client.query(
    `INSERT INTO memory_curator_run
      (id, user_id, job_key, job_type, status)
     VALUES ($1, $2, $3, 'review', 'running')`,
    [runId, userId, jobKey],
  );
  return runId;
}

async function insertUserMessage(id: string, text: string) {
  await client.query(
    `INSERT INTO chat_message (id, thread_id, role, parts)
     VALUES ($1, $2, 'user', $3::json[])`,
    [id, threadId, [`{"type":"text","text":${JSON.stringify(text)}}`]],
  );
}

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
  userId = randomUUID();
  threadId = randomUUID();
  await client.query(
    `INSERT INTO "user" (id, name, email, password)
     VALUES ($1, 'Memory User', $2, 'hash')`,
    [userId, `memory-${userId}@example.test`],
  );
  await client.query(
    `INSERT INTO chat_thread (id, title, user_id)
     VALUES ($1, 'Memory review', $2)`,
    [threadId, userId],
  );
  repository = (
    await import("lib/db/pg/repositories/memory-review-repository.pg")
  ).pgMemoryReviewRepository;
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("agentic memory operation transaction", () => {
  test("adds once and rejects a second commit for the same run", async () => {
    const messageId = `message-${randomUUID()}`;
    const userText = "aku suka jus jambu";
    await insertUserMessage(messageId, userText);
    const runId = await insertRun(`review:${messageId}`);
    const batch = {
      operations: [
        {
          action: "add" as const,
          kind: "preference" as const,
          scopeType: "global" as const,
          content: "User suka jus jambu",
          topicKey: "preferences.food-drink" as const,
          entities: ["jus jambu"],
          evidenceQuote: userText,
          reason: "Explicit durable preference",
          confidence: 0.95,
        },
      ],
    };
    const result = await repository.commitOperations({
      runId,
      userId,
      threadId,
      messageId,
      userText,
      scopes: [{ scopeType: "global", scopeId: null }],
      allowedScopeTypes: ["global"],
      allowedTargetIds: new Set(),
      batch,
      mode: "write",
    });
    expect(result.stats.add).toBe(1);
    await expect(
      repository.commitOperations({
        runId,
        userId,
        threadId,
        messageId,
        userText,
        scopes: [{ scopeType: "global", scopeId: null }],
        allowedScopeTypes: ["global"],
        allowedTargetIds: new Set(),
        batch,
        mode: "write",
      }),
    ).rejects.toThrow(/already committed/i);
    const count = await client.query(
      `SELECT count(*)::int AS count FROM user_memory
       WHERE user_id = $1 AND status = 'active'`,
      [userId],
    );
    expect(count.rows[0].count).toBe(1);
  });

  test("preserves a corrected claim as superseded lineage", async () => {
    const [old] = (
      await client.query(
        `SELECT id FROM user_memory
         WHERE user_id = $1 AND status = 'active' LIMIT 1`,
        [userId],
      )
    ).rows;
    const messageId = `message-${randomUUID()}`;
    const userText = "aku sudah tidak suka jus jambu";
    await insertUserMessage(messageId, userText);
    const runId = await insertRun(`review:${messageId}`);
    const result = await repository.commitOperations({
      runId,
      userId,
      threadId,
      messageId,
      userText,
      scopes: [{ scopeType: "global", scopeId: null }],
      allowedScopeTypes: ["global"],
      allowedTargetIds: new Set([old.id]),
      batch: {
        operations: [
          {
            action: "supersede",
            targetId: old.id,
            explicitCurrentCorrection: true,
            evidenceQuote: userText,
            reason: "Explicit current correction",
            confidence: 0.97,
            replacements: [
              {
                kind: "preference",
                content: "User tidak suka jus jambu",
                topicKey: "preferences.food-drink",
                entities: ["jus jambu"],
              },
            ],
          },
        ],
      },
      mode: "write",
    });
    expect(result.stats.supersede).toBe(1);
    const claims = await client.query(
      `SELECT id, content, status FROM user_memory
       WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    expect(claims.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: old.id, status: "superseded" }),
        expect.objectContaining({
          content: "User tidak suka jus jambu",
          status: "active",
        }),
      ]),
    );
    const lineage = await client.query(
      `SELECT count(*)::int AS count FROM memory_edge
       WHERE user_id = $1 AND target_id = $2 AND type = 'SUPERSEDES'`,
      [userId, old.id],
    );
    expect(lineage.rows[0].count).toBe(1);
  });

  test("rolls back the whole batch when evidence is invalid", async () => {
    const messageId = `message-${randomUUID()}`;
    const userText = "aku suka susu";
    await insertUserMessage(messageId, userText);
    const runId = await insertRun(`review:${messageId}`);
    await expect(
      repository.commitOperations({
        runId,
        userId,
        threadId,
        messageId,
        userText,
        scopes: [{ scopeType: "global", scopeId: null }],
        allowedScopeTypes: ["global"],
        allowedTargetIds: new Set(),
        batch: {
          operations: [
            {
              action: "add",
              kind: "preference",
              scopeType: "global",
              content: "User suka susu",
              topicKey: "preferences.food-drink",
              entities: ["susu"],
              evidenceQuote: userText,
              reason: "Explicit preference",
              confidence: 0.95,
            },
            {
              action: "add",
              kind: "preference",
              scopeType: "global",
              content: "Invalid unsupported claim",
              topicKey: "preferences.general",
              entities: [],
              evidenceQuote: "text that the user never said",
              reason: "Invalid evidence",
              confidence: 0.95,
            },
          ],
        },
        mode: "write",
      }),
    ).rejects.toThrow(/quote/i);
    const count = await client.query(
      `SELECT count(*)::int AS count FROM user_memory
       WHERE user_id = $1 AND content = 'User suka susu'`,
      [userId],
    );
    expect(count.rows[0].count).toBe(0);
  });

  test("keeps the unaffected part of a corrected compound claim", async () => {
    const compoundId = randomUUID();
    await client.query(
      `INSERT INTO user_memory
        (id, user_id, kind, content, confidence, status, provenance)
       VALUES ($1, $2, 'preference', $3, 95, 'active', 'background_review')`,
      [compoundId, userId, "User suka susu dan jus mangga"],
    );
    const messageId = `message-${randomUUID()}`;
    const userText = "aku sudah tidak suka jus mangga";
    await insertUserMessage(messageId, userText);
    const runId = await insertRun(`review:${messageId}`);
    await repository.commitOperations({
      runId,
      userId,
      threadId,
      messageId,
      userText,
      scopes: [{ scopeType: "global", scopeId: null }],
      allowedScopeTypes: ["global"],
      allowedTargetIds: new Set([compoundId]),
      batch: {
        operations: [
          {
            action: "supersede",
            targetId: compoundId,
            explicitCurrentCorrection: true,
            evidenceQuote: userText,
            reason: "Only one atomic preference changed",
            confidence: 0.97,
            replacements: [
              {
                kind: "preference",
                content: "User suka susu",
                topicKey: "preferences.food-drink",
                entities: ["susu"],
              },
              {
                kind: "preference",
                content: "User tidak suka jus mangga",
                topicKey: "preferences.food-drink",
                entities: ["jus mangga"],
              },
            ],
          },
        ],
      },
      mode: "write",
    });
    const rows = await client.query(
      `SELECT content, status FROM user_memory
       WHERE user_id = $1 AND content IN ($2, $3, $4)`,
      [
        userId,
        "User suka susu dan jus mangga",
        "User suka susu",
        "User tidak suka jus mangga",
      ],
    );
    expect(rows.rows).toEqual(
      expect.arrayContaining([
        {
          content: "User suka susu dan jus mangga",
          status: "superseded",
        },
        { content: "User suka susu", status: "active" },
        { content: "User tidak suka jus mangga", status: "active" },
      ]),
    );
  });

  test("validates and audits shadow proposals without writing claims", async () => {
    const messageId = `message-${randomUUID()}`;
    const userText = "aku suka teh melati";
    await insertUserMessage(messageId, userText);
    const runId = await insertRun(`review:${messageId}`);
    await repository.commitOperations({
      runId,
      userId,
      threadId,
      messageId,
      userText,
      scopes: [{ scopeType: "global", scopeId: null }],
      allowedScopeTypes: ["global"],
      allowedTargetIds: new Set(),
      batch: {
        operations: [
          {
            action: "add",
            kind: "preference",
            scopeType: "global",
            content: "User suka teh melati",
            topicKey: "preferences.food-drink",
            entities: ["teh melati"],
            evidenceQuote: userText,
            reason: "Explicit durable preference",
            confidence: 0.95,
          },
        ],
      },
      mode: "shadow",
    });
    const claim = await client.query(
      `SELECT count(*)::int AS count FROM user_memory
       WHERE user_id = $1 AND content = 'User suka teh melati'`,
      [userId],
    );
    const run = await client.query(
      `SELECT status, rollback_snapshot FROM memory_curator_run WHERE id = $1`,
      [runId],
    );
    expect(claim.rows[0].count).toBe(0);
    expect(run.rows[0].status).toBe("completed");
    expect(run.rows[0].rollback_snapshot.operations).toHaveLength(1);
  });
});
