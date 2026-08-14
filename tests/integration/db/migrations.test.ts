import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");

const client = new Client({ connectionString });

beforeAll(async () => client.connect());
afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("IRIS V2 PostgreSQL migrations", () => {
  test("applies every migration to an empty database", async () => {
    await recreatePublicSchema(client);
    const applied = await applyMigrations(client);
    expect(applied.at(-1)).toMatch(/^0028_/);
    const result = await client.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(result.rows[0].count).toBeGreaterThan(20);
  });

  test("backfills legacy memory and preserves exact global scope", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client, {
      through: "0021_workspace_foundation.sql",
    });
    const userId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Legacy User', $2, 'hash')`,
      [userId, `legacy-${userId}@example.test`],
    );
    const memoryId = randomUUID();
    await client.query(
      `INSERT INTO user_memory
        (id, user_id, kind, content, confidence, status, provenance)
       VALUES ($1, $2, 'fact', 'Legacy durable fact', 90, 'active', 'manual')`,
      [memoryId, userId],
    );
    const topicId = randomUUID();
    const entityId = randomUUID();
    await client.query(
      `INSERT INTO memory_topic
        (id, user_id, label, normalized_key, confidence)
       VALUES ($1, $2, 'Legacy facts', 'fact', 90)`,
      [topicId, userId],
    );
    await client.query(
      `INSERT INTO memory_entity
        (id, user_id, name, normalized_key, confidence)
       VALUES ($1, $2, 'IRIS', 'iris', 85)`,
      [entityId, userId],
    );
    await client.query(
      `INSERT INTO memory_edge
        (user_id, source_id, source_type, target_id, target_type, type,
         confidence, provenance)
       VALUES ($1, $2, 'claim', $3, 'topic', 'ABOUT', 90, 'manual')`,
      [userId, memoryId, topicId],
    );
    await client.query(
      `INSERT INTO memory_evidence
        (user_id, memory_id, excerpt, content_hash)
       VALUES ($1, $2, 'Legacy durable fact', md5('Legacy durable fact'))`,
      [userId, memoryId],
    );
    await client.query(
      `INSERT INTO memory_embedding
        (user_id, node_id, node_type, model, dimensions, values, content_hash)
       VALUES ($1, $2, 'claim', 'fixture', 3, '[0.1,0.2,0.3]'::json,
               md5('Legacy durable fact'))`,
      [userId, memoryId],
    );
    await client.query(
      `INSERT INTO memory_curator_run (user_id, job_type, status)
       VALUES ($1, 'curate', 'completed')`,
      [userId],
    );
    await client.query(
      `INSERT INTO memory_retrieval_audit (user_id, query_hash)
       VALUES ($1, md5('legacy query'))`,
      [userId],
    );

    await applyMigrations(client, {
      after: "0021_workspace_foundation.sql",
    });

    const memory = await client.query(
      `SELECT kind, scope_type, scope_id FROM user_memory WHERE id = $1`,
      [memoryId],
    );
    expect(memory.rows[0]).toEqual({
      kind: "semantic",
      scope_type: "global",
      scope_id: null,
    });

    const scopedGraph = await client.query(
      `SELECT count(*)::int AS count FROM (
         SELECT scope_type, scope_id FROM memory_topic WHERE user_id = $1
         UNION ALL SELECT scope_type, scope_id FROM memory_entity WHERE user_id = $1
         UNION ALL SELECT scope_type, scope_id FROM memory_edge WHERE user_id = $1
         UNION ALL SELECT scope_type, scope_id FROM memory_evidence WHERE user_id = $1
         UNION ALL SELECT scope_type, scope_id FROM memory_embedding WHERE user_id = $1
         UNION ALL SELECT scope_type, scope_id FROM memory_curator_run WHERE user_id = $1
         UNION ALL SELECT scope_type, scope_id FROM memory_retrieval_audit WHERE user_id = $1
       ) graph WHERE scope_type <> 'global' OR scope_id IS NOT NULL`,
      [userId],
    );
    expect(scopedGraph.rows[0].count).toBe(0);

    await expect(
      client.query(
        `INSERT INTO memory_topic
          (user_id, scope_type, scope_id, label, normalized_key)
         VALUES ($1, 'global', NULL, 'Duplicate', 'fact')`,
        [userId],
      ),
    ).rejects.toThrow();
  });

  test("rejects invalid scope pairs and cross-scope edges", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const userId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Scope User', $2, 'hash')`,
      [userId, `scope-${userId}@example.test`],
    );
    await expect(
      client.query(
        `INSERT INTO memory_topic
          (user_id, scope_type, scope_id, label, normalized_key)
         VALUES ($1, 'workspace', NULL, 'Invalid', 'invalid')`,
        [userId],
      ),
    ).rejects.toThrow();

    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    await client.query(
      `INSERT INTO workspace (id, user_id, name, slug)
       VALUES ($1, $3, 'A', 'a'), ($2, $3, 'B', 'b')`,
      [workspaceA, workspaceB, userId],
    );
    const sourceId = randomUUID();
    const targetId = randomUUID();
    await client.query(
      `INSERT INTO memory_topic
        (id, user_id, scope_type, scope_id, label, normalized_key)
       VALUES ($1, $3, 'workspace', $4, 'Source', 'source'),
              ($2, $3, 'workspace', $5, 'Target', 'target')`,
      [sourceId, targetId, userId, workspaceA, workspaceB],
    );
    await expect(
      client.query(
        `INSERT INTO memory_edge
          (user_id, scope_type, scope_id, source_id, source_type,
           target_id, target_type, type)
         VALUES ($1, 'workspace', $2, $3, 'topic', $4, 'topic', 'RELATED_TO')`,
        [userId, workspaceA, sourceId, targetId],
      ),
    ).rejects.toThrow(/scope/i);
  });
});
