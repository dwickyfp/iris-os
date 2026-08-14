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
    expect(applied).toContain("0036_system_model_engines.sql");
    const result = await client.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(result.rows[0].count).toBeGreaterThan(20);
  });

  test("backfills legacy curator and embedding model engine assignments", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client, {
      through: "0035_agentic_memory_curator.sql",
    });
    const providerId = randomUUID();
    const curatorId = randomUUID();
    const embeddingId = randomUUID();
    await client.query(
      `INSERT INTO model_provider (id, name, type)
       VALUES ($1, 'Engine Provider', 'openai')`,
      [providerId],
    );
    await client.query(
      `INSERT INTO model_configuration
        (id, provider_id, name, api_model_id, model_kind, is_curator,
         is_embedding_default)
       VALUES ($1, $3, 'Curator', 'curator-model', 'chat', true, false),
              ($2, $3, 'Embedding', 'embedding-model', 'embedding', false, true)`,
      [curatorId, embeddingId, providerId],
    );

    await applyMigrations(client, {
      after: "0035_agentic_memory_curator.sql",
    });

    const assignments = await client.query(
      `SELECT engine_key, model_id
       FROM model_engine_assignment
       ORDER BY engine_key`,
    );
    expect(assignments.rows).toEqual([
      { engine_key: "memory-curator", model_id: curatorId },
      { engine_key: "memory-embedding", model_id: embeddingId },
    ]);
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

  test("enforces task ownership, parent cycles, transitions, and timestamps", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const userId = randomUUID();
    const otherUserId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password) VALUES
       ($1, 'Task Owner', $3, 'hash'), ($2, 'Other Owner', $4, 'hash')`,
      [
        userId,
        otherUserId,
        `task-${userId}@example.test`,
        `task-${otherUserId}@example.test`,
      ],
    );
    const foreignAgentId = randomUUID();
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Foreign')`,
      [foreignAgentId, otherUserId],
    );
    await expect(
      client.query(
        `INSERT INTO iris_task (user_id, assigned_agent_id, title)
         VALUES ($1, $2, 'Invalid owner')`,
        [userId, foreignAgentId],
      ),
    ).rejects.toThrow(/owned/i);

    const parentId = randomUUID();
    const childId = randomUUID();
    await client.query(
      `INSERT INTO iris_task (id, user_id, title) VALUES
       ($1, $3, 'Parent'), ($2, $3, 'Child')`,
      [parentId, childId, userId],
    );
    await client.query(
      `UPDATE iris_task SET parent_task_id = $1 WHERE id = $2`,
      [parentId, childId],
    );
    await expect(
      client.query(`UPDATE iris_task SET parent_task_id = $1 WHERE id = $2`, [
        childId,
        parentId,
      ]),
    ).rejects.toThrow(/cycle/i);
    await expect(
      client.query(`UPDATE iris_task SET status = 'completed' WHERE id = $1`, [
        parentId,
      ]),
    ).rejects.toThrow(/transition/i);
    const started = await client.query(
      `UPDATE iris_task SET status = 'in_progress' WHERE id = $1
       RETURNING started_at`,
      [parentId],
    );
    expect(started.rows[0].started_at).not.toBeNull();

    await expect(
      client.query(
        `INSERT INTO task_resource_ref
          (task_id, user_id, kind, reference_id)
         VALUES ($1, $2, 'url', 'https://example.test')`,
        [parentId, otherUserId],
      ),
    ).rejects.toThrow(/ownership/i);
  });

  test("reconciles legacy inbox candidates for chat-first learning", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client, { through: "0033_task_integrity.sql" });
    const userId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Learning User', $2, 'hash')`,
      [userId, `learning-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO learning_setting
        (user_id, allowed_categories, autonomy_level)
       VALUES ($1, '["memory","skill","automation"]'::json, 1)`,
      [userId],
    );

    for (const [index, candidateType] of [
      "memory",
      "automation",
      "skill",
    ].entries()) {
      const eventId = randomUUID();
      const observationId = randomUUID();
      await client.query(
        `INSERT INTO iris_activity_event
          (id, user_id, actor_type, event_type, subject_type, idempotency_key)
         VALUES ($1, $2, 'system', 'chat.completed', 'thread', $3)`,
        [eventId, userId, `legacy-learning-${index}`],
      );
      await client.query(
        `INSERT INTO learning_observation
          (id, event_id, user_id, scope_type, observation_type, summary,
           confidence)
         VALUES ($1, $2, $3, 'global', 'legacy', $4, 80)`,
        [observationId, eventId, userId, `${candidateType} observation`],
      );
      await client.query(
        `INSERT INTO learning_candidate
          (user_id, observation_id, scope_type, candidate_type, title,
           proposed_payload, confidence, status, suppression_key,
           evidence_count)
         VALUES ($1, $2, 'global', $3, $4, '{}'::json, 80, 'pending', $5, $6)`,
        [
          userId,
          observationId,
          candidateType,
          `${candidateType} candidate`,
          String(index).padStart(64, "0"),
          candidateType === "skill" ? 3 : 1,
        ],
      );
    }

    await applyMigrations(client, { after: "0033_task_integrity.sql" });

    const candidates = await client.query(
      `SELECT candidate_type, status, resolution_reason
       FROM learning_candidate ORDER BY candidate_type`,
    );
    expect(candidates.rows).toEqual([
      {
        candidate_type: "automation",
        status: "superseded",
        resolution_reason: "inferred_automation_disabled",
      },
      {
        candidate_type: "memory",
        status: "superseded",
        resolution_reason: "duplicate_memory_pipeline",
      },
      {
        candidate_type: "skill",
        status: "pending",
        resolution_reason: null,
      },
    ]);
    const settings = await client.query(
      `SELECT allowed_categories FROM learning_setting WHERE user_id = $1`,
      [userId],
    );
    expect(settings.rows[0].allowed_categories).toEqual(["memory", "skill"]);
    const attempts = await client.query(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'learning_promotion_attempt'`,
    );
    expect(attempts.rows[0].count).toBe(1);
  });
});
