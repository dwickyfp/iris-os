import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;
vi.mock("server-only", () => ({}));

const client = new Client({ connectionString });

beforeAll(async () => client.connect());
afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("IRIS V2 PostgreSQL migrations", () => {
  test("adds nullable automation authority snapshots without widening legacy runs", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client, {
      through: "0061_root_run_budget.sql",
    });
    const userId = randomUUID();
    const automationId = randomUUID();
    const legacyRunId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Automation Owner', $2, 'hash')`,
      [userId, `automation-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO automation
         (id, user_id, name, trigger_type, target_type, target_id,
          approval_policy, timeout_ms)
       VALUES ($1, $2, 'Legacy automation', 'manual', 'agent', $3, 'never', 1000)`,
      [automationId, userId, randomUUID()],
    );
    await client.query(
      `INSERT INTO automation_run
         (id, automation_id, user_id, idempotency_key, scheduled_for)
       VALUES ($1, $2, $3, 'legacy', NOW())`,
      [legacyRunId, automationId, userId],
    );

    await applyMigrations(client, {
      after: "0061_root_run_budget.sql",
      through: "0062_automation_authority_snapshot.sql",
    });

    const legacy = await client.query(
      `SELECT authorization_context FROM automation_run WHERE id = $1`,
      [legacyRunId],
    );
    expect(legacy.rows[0].authorization_context).toBeNull();
    const snapshot = {
      version: 1,
      allowedTools: [],
      capabilityIds: [],
    };
    await client.query(
      `UPDATE automation_run SET authorization_context = $2::json WHERE id = $1`,
      [legacyRunId, JSON.stringify(snapshot)],
    );
    const persisted = await client.query(
      `SELECT authorization_context FROM automation_run WHERE id = $1`,
      [legacyRunId],
    );
    expect(persisted.rows[0].authorization_context).toEqual(snapshot);
  });

  test("upgrades pre-0061 unsettled sandbox reservations into the root ledger", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client, {
      through: "0058_orphan_artifact_cleanup.sql",
    });
    const userId = randomUUID();
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const rootSessionId = randomUUID();
    const childSessionId = randomUUID();
    const runningId = randomUUID();
    const terminalId = randomUUID();
    const stale = new Date("2000-01-01T00:00:00.000Z");
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Upgrade Owner', $2, 'hash')`,
      [userId, `upgrade-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run
         (id, user_id, parent_run_id, root_run_id, depth, status, lease_token,
          lease_expires_at, absolute_deadline_at, attempt)
       VALUES ($1, $3, NULL, $1, 0, 'running', gen_random_uuid(),
               NOW() + interval '30 seconds', NOW() + interval '5 minutes', 1),
              ($2, $3, $1, $1, 1, 'running', gen_random_uuid(),
               NOW() + interval '30 seconds', NOW() + interval '5 minutes', 1)`,
      [rootRunId, childRunId, userId],
    );
    await client.query(
      `INSERT INTO sandbox_session
         (id, run_id, user_id, provider, provider_instance_id, profile, status,
          last_used_at, expires_at, created_at)
        VALUES ($1, $3, $4, 'iris-runner', 'upgrade-root', $5::json,
                'active', NOW(), NOW() + interval '5 minutes', NOW()),
               ($2, $6, $4, 'iris-runner', 'upgrade-child', $5::json,
                'active', NOW(), NOW() + interval '5 minutes', NOW())`,
      [
        rootSessionId,
        childSessionId,
        rootRunId,
        userId,
        JSON.stringify({
          id: "python",
          cpuMillis: 1000,
          memoryMb: 512,
          diskMb: 1024,
          executionTimeoutMs: 1000,
          idleTimeoutMs: 60000,
          network: "none",
        }),
        childRunId,
      ],
    );
    await client.query(
      `INSERT INTO sandbox_execution
         (id, session_id, run_id, status, reserved_compute_ms, started_at,
          completed_at)
        VALUES ($5, $1, $3, 'running', 300, $4, NULL),
               ($6, $2, $7, 'failed', 400, $4, $4)`,
      [
        rootSessionId,
        childSessionId,
        rootRunId,
        stale,
        runningId,
        terminalId,
        childRunId,
      ],
    );
    await applyMigrations(client, {
      after: "0058_orphan_artifact_cleanup.sql",
      through: "0060_automation_budget_exhausted.sql",
    });
    const preUpgrade = await client.query(
      `SELECT run_id, reserved_compute_ms, committed_compute_ms
       FROM sandbox_run_compute_budget WHERE run_id = ANY($1::uuid[])
       ORDER BY run_id`,
      [[rootRunId, childRunId]],
    );
    expect(preUpgrade.rows).toEqual(
      expect.arrayContaining([
        {
          run_id: rootRunId,
          reserved_compute_ms: 300,
          committed_compute_ms: 0,
        },
        {
          run_id: childRunId,
          reserved_compute_ms: 0,
          committed_compute_ms: 0,
        },
      ]),
    );

    await applyMigrations(client, {
      after: "0060_automation_budget_exhausted.sql",
      through: "0061_root_run_budget.sql",
    });

    const upgraded = await client.query(
      `SELECT b.reserved_sandbox_compute_ms,
              COALESCE(SUM(r.amount) FILTER (WHERE r.state = 'reserved'), 0)::int
                AS ledger_reserved,
              count(r.token)::int AS reservations
       FROM root_run_budget b
       LEFT JOIN root_run_budget_reservation r
         ON r.root_run_id = b.root_run_id
       WHERE b.root_run_id = $1
       GROUP BY b.root_run_id`,
      [rootRunId],
    );
    expect(upgraded.rows[0]).toEqual({
      reserved_sandbox_compute_ms: 700,
      ledger_reserved: 700,
      reservations: 2,
    });

    const perRunUpgraded = await client.query(
      `SELECT run_id, reserved_compute_ms, committed_compute_ms
       FROM sandbox_run_compute_budget WHERE run_id = ANY($1::uuid[])`,
      [[rootRunId, childRunId]],
    );
    expect(perRunUpgraded.rows).toEqual(
      expect.arrayContaining([
        {
          run_id: rootRunId,
          reserved_compute_ms: 300,
          committed_compute_ms: 0,
        },
        {
          run_id: childRunId,
          reserved_compute_ms: 400,
          committed_compute_ms: 0,
        },
      ]),
    );

    const tokens = await client.query(
      `SELECT id, reservation_token FROM sandbox_execution
       WHERE run_id = ANY($1::uuid[])`,
      [[rootRunId, childRunId]],
    );
    const runningToken = tokens.rows.find((row) => row.id === runningId)
      .reservation_token;

    const repository = (
      await import("lib/db/pg/repositories/sandbox-repository.pg")
    ).pgSandboxRepository;
    await expect(
      repository.settleExecution(runningId, runningToken, 125, 150, new Date()),
    ).resolves.toBe(true);
    await expect(
      repository.settleExecution(runningId, runningToken, 125, 150, new Date()),
    ).resolves.toBe(false);
    await expect(
      repository.reconcileStaleExecutions(new Date(), 10),
    ).resolves.toBe(1);
    await expect(
      repository.reconcileStaleExecutions(new Date(), 10),
    ).resolves.toBe(0);
    const settled = await client.query(
      `SELECT b.reserved_compute_ms, b.committed_compute_ms,
              root.reserved_sandbox_compute_ms,
              root.committed_sandbox_compute_ms,
              count(*) FILTER (WHERE ledger.state = 'committed')::int
                AS committed,
              count(*) FILTER (WHERE ledger.state = 'released')::int
                AS released
       FROM sandbox_run_compute_budget b
       JOIN agent_run run ON run.id = b.run_id
       JOIN root_run_budget root ON root.root_run_id = run.root_run_id
       JOIN root_run_budget_reservation ledger ON ledger.run_id = b.run_id
       WHERE b.run_id = ANY($1::uuid[])
       GROUP BY b.run_id, root.root_run_id
       ORDER BY b.run_id`,
      [[rootRunId, childRunId]],
    );
    expect(settled.rows).toEqual(
      expect.arrayContaining([
        {
          reserved_compute_ms: 0,
          committed_compute_ms: 125,
          reserved_sandbox_compute_ms: 0,
          committed_sandbox_compute_ms: 525,
          committed: 1,
          released: 0,
        },
        {
          reserved_compute_ms: 0,
          committed_compute_ms: 400,
          reserved_sandbox_compute_ms: 0,
          committed_sandbox_compute_ms: 525,
          committed: 1,
          released: 0,
        },
      ]),
    );
  });

  test("persists bounded sandbox sessions and executions", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const userId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const executionId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Sandbox Owner', $2, 'hash')`,
      [userId, `sandbox-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run (id, user_id, root_run_id, status)
       VALUES ($1, $2, $1, 'queued')`,
      [runId, userId],
    );
    await client.query(
      `INSERT INTO sandbox_session
         (id, run_id, user_id, provider, profile, status, last_used_at,
          expires_at, created_at)
       VALUES ($1, $2, $3, 'iris-runner', $4::json, 'creating', NOW(),
               NOW() + interval '5 minutes', NOW())`,
      [sessionId, runId, userId, JSON.stringify({ id: "data_compute" })],
    );
    await client.query(
      `INSERT INTO sandbox_execution
          (id, session_id, run_id, status, reservation_token,
           reserved_compute_ms, reservation_expires_at, settlement_deadline_at,
           started_at)
        VALUES ($1, $2, $3, 'running', gen_random_uuid(), 1000,
                NOW() + interval '1 minute', NOW() + interval '2 minutes', NOW())`,
      [executionId, sessionId, runId],
    );
    await expect(
      client.query(
        `UPDATE sandbox_execution SET status = 'succeeded', exit_code = 0
         WHERE id = $1`,
        [executionId],
      ),
    ).rejects.toThrow(/sandbox_execution_terminal_check/i);
    await expect(
      client.query(
        `UPDATE sandbox_execution
         SET status = 'failed', duration_ms = 1001,
             observed_wall_duration_ms = 1200, completed_at = NOW()
         WHERE id = $1`,
        [executionId],
      ),
    ).rejects.toThrow(/sandbox_execution_compute_check/i);
    await client.query(
      `UPDATE sandbox_execution
       SET status = 'failed', duration_ms = 1000,
           observed_wall_duration_ms = 1200, completed_at = NOW()
       WHERE id = $1`,
      [executionId],
    );
  });
  test("applies every migration to an empty database", async () => {
    await recreatePublicSchema(client);
    const applied = await applyMigrations(client);
    expect(applied).toContain("0037_remote_agents_a2a.sql");
    expect(applied).toContain("0038_remote_delegation.sql");
    expect(applied).toContain("0039_agent_run_waiting_states.sql");
    expect(applied).toContain("0040_canonical_artifacts.sql");
    expect(applied).toContain("0041_durable_a2a_lifecycle.sql");
    expect(applied).toContain("0042_artifact_owner_run_binding.sql");
    expect(applied).toContain("0043_remote_cancel_reconciliation.sql");
    expect(applied).toContain("0044_agent_run_parent_rejoin.sql");
    expect(applied).toContain("0045_agent_run_join_generation.sql");
    expect(applied).toContain("0046_worker_heartbeat.sql");
    expect(applied).toContain("0047_memory_fts_indexes.sql");
    expect(applied).toContain("0048_runtime_event_sequence.sql");
    expect(applied).toContain("0049_agent_run_budget_exhausted.sql");
    expect(applied).toContain("0051_agent_run_root_trajectory.sql");
    expect(applied).toContain("0054_sandbox_artifact_outputs.sql");
    expect(applied).toContain("0055_sandbox_control_plane.sql");
    expect(applied).toContain("0057_sandbox_accounting_artifact_cleanup.sql");
    expect(applied).toContain("0058_orphan_artifact_cleanup.sql");
    expect(applied).toContain("0059_sandbox_durable_compute_budget.sql");
    expect(applied).toContain("0060_automation_budget_exhausted.sql");
    expect(applied).toContain("0061_root_run_budget.sql");
    expect(applied).toContain("0056_sandbox_creation_fencing.sql");
    const result = await client.query(
      "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(result.rows[0].count).toBeGreaterThan(20);
  });

  test("persists budget exhaustion for automation runs and attempts", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const userId = randomUUID();
    const automationId = randomUUID();
    const runId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Automation Owner', $2, 'hash')`,
      [userId, `automation-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO automation
         (id, user_id, name, trigger_type, target_type, target_id,
          approval_policy)
       VALUES ($1, $2, 'Budget test', 'manual', 'agent', $3, 'never')`,
      [automationId, userId, randomUUID()],
    );
    await client.query(
      `INSERT INTO automation_run
         (id, automation_id, user_id, idempotency_key, status, scheduled_for,
          error_code, completed_at)
       VALUES ($1, $2, $3, 'budget-test', 'budget_exhausted', NOW(),
               'BUDGET_EXHAUSTED', NOW())`,
      [runId, automationId, userId],
    );
    await client.query(
      `INSERT INTO automation_run_attempt
         (run_id, attempt, status, error_code, completed_at)
       VALUES ($1, 1, 'budget_exhausted', 'BUDGET_EXHAUSTED', NOW())`,
      [runId],
    );
    const persisted = await client.query(
      `SELECT r.status AS run_status, a.status AS attempt_status
       FROM automation_run r
       JOIN automation_run_attempt a ON a.run_id = r.id
       WHERE r.id = $1`,
      [runId],
    );
    expect(persisted.rows).toEqual([
      {
        run_status: "budget_exhausted",
        attempt_status: "budget_exhausted",
      },
    ]);
  });

  test("creates full-text search indexes for memory keyword recall", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const indexes = await client.query(
      `SELECT indexname AS name
       FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('user_memory_content_fts_idx',
                           'chat_message_search_content_fts_idx')
       ORDER BY indexname`,
    );
    expect(indexes.rows).toEqual([
      { name: "chat_message_search_content_fts_idx" },
      { name: "user_memory_content_fts_idx" },
    ]);
  });

  test("records worker heartbeats and exposes an empty pg-boss snapshot", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    await client.query(
      `INSERT INTO iris_worker_heartbeat (worker_id, hostname, pid, version)
       VALUES ('worker-1', 'host-1', 42, '1.26.0')`,
    );
    const result = await client.query(
      `SELECT worker_id, iris_pgboss_snapshot() AS queue
       FROM iris_worker_heartbeat`,
    );
    expect(result.rows).toEqual([
      {
        worker_id: "worker-1",
        queue: { installed: false, jobs: {} },
      },
    ]);
    await expect(
      client.query(
        `INSERT INTO iris_worker_heartbeat
          (worker_id, hostname, pid, version)
         VALUES ('invalid', 'host-1', 0, '1.26.0')`,
      ),
    ).rejects.toThrow();
  });

  test("supports waiting transitions, fenced lease reclaim, and one-shot continuation", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const userId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const delegationId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Run Owner', $2, 'hash')`,
      [userId, `run-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run
        (id, user_id, root_run_id, status, lease_token, lease_expires_at, started_at,
         absolute_deadline_at, attempt)
       VALUES ($1, $3, $1, 'running', gen_random_uuid(), NOW() + interval '1 minute',
               NOW(), NOW() + interval '10 minutes', 1),
              ($2, $3, $2, 'queued', NULL, NULL, NULL,
               NOW() + interval '10 minutes', 0)`,
      [parentId, childId, userId],
    );
    await client.query(
      `INSERT INTO delegation_run
        (id, parent_run_id, child_run_id, user_id, objective, idempotency_key)
       VALUES ($1, $2, $3, $4, 'wait safely', 'request-1')`,
      [delegationId, parentId, childId, userId],
    );

    const lease1 = randomUUID();
    await client.query(
      `UPDATE agent_run SET status = 'running', lease_token = $2,
         lease_expires_at = NOW() - interval '1 second', started_at = NOW(),
         attempt = attempt + 1 WHERE id = $1`,
      [childId, lease1],
    );
    const lease2 = randomUUID();
    const reclaimed = await client.query(
      `UPDATE agent_run SET lease_token = $2,
         lease_expires_at = NOW() + interval '1 minute', attempt = attempt + 1
       WHERE id = $1 AND status = 'running' AND lease_expires_at <= NOW()
       RETURNING attempt`,
      [childId, lease2],
    );
    expect(reclaimed.rows[0].attempt).toBe(2);
    const oldWorker = await client.query(
      `UPDATE agent_run SET status = 'succeeded', lease_token = NULL,
         lease_expires_at = NULL WHERE id = $1 AND lease_token = $2
       RETURNING id`,
      [childId, lease1],
    );
    expect(oldWorker.rowCount).toBe(0);

    await client.query(
      `UPDATE agent_run SET status = 'waiting_input', waiting_reason = 'INPUT',
         lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1 AND lease_token = $2`,
      [childId, lease2],
    );
    await client.query(
      `INSERT INTO agent_run_continuation
        (run_id, kind, submission_id, message_id, payload)
       VALUES ($1, 'input', gen_random_uuid(), gen_random_uuid(),
               '{"message":"continue"}'::json)`,
      [childId],
    );
    const continuation = await client.query(
      `UPDATE agent_run_continuation SET consumed_at = NOW()
       WHERE run_id = $1 AND consumed_at IS NULL RETURNING payload`,
      [childId],
    );
    expect(continuation.rows[0].payload).toEqual({ message: "continue" });
    const duplicateConsume = await client.query(
      `UPDATE agent_run_continuation SET consumed_at = NOW()
       WHERE run_id = $1 AND consumed_at IS NULL RETURNING payload`,
      [childId],
    );
    expect(duplicateConsume.rowCount).toBe(0);
  });

  test("persists canonical artifacts and append-only verification evidence", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const artifactId = randomUUID();
    const userId = randomUUID();
    const runId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Artifact Owner', $2, 'hash')`,
      [userId, `artifact-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run (id, user_id, root_run_id, status)
       VALUES ($1, $2, $1, 'succeeded')`,
      [runId, userId],
    );
    await client.query(
      `INSERT INTO artifact
        (id, user_id, run_id, storage_key, filename, media_type, size, sha256)
       VALUES ($1, $2, $3, 'reports/report.md', 'report.md', 'text/markdown', 12, $4)`,
      [artifactId, userId, runId, "a".repeat(64)],
    );
    await client.query(
      `INSERT INTO artifact_verification
        (artifact_id, verified, details)
       VALUES ($1, true, '{"storage":true,"metadata":true,"hash":true}'::json)`,
      [artifactId],
    );
    await expect(
      client.query(
        `INSERT INTO artifact_verification
          (artifact_id, verified, reason)
         VALUES ($1, false, NULL)`,
        [artifactId],
      ),
    ).rejects.toThrow();
    const result = await client.query(
      `SELECT verified, details FROM artifact_verification
       WHERE artifact_id = $1`,
      [artifactId],
    );
    expect(result.rows).toEqual([
      {
        verified: true,
        details: { storage: true, metadata: true, hash: true },
      },
    ]);
    await expect(
      client.query(
        `INSERT INTO artifact (storage_key, filename, media_type, size, sha256)
         VALUES ('reports/unowned.md', 'unowned.md', 'text/markdown', 1, $1)`,
        ["b".repeat(64)],
      ),
    ).rejects.toThrow();
  });

  test("creates owner-scoped remote agents with consistent credentials", async () => {
    await recreatePublicSchema(client);
    await applyMigrations(client);
    const userId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'A2A Owner', $2, 'hash')`,
      [userId, `a2a-${userId}@example.test`],
    );
    const id = randomUUID();
    await client.query(
      `INSERT INTO remote_agent
        (id, user_id, name, endpoint_url, credential_type,
         encrypted_credential)
       VALUES ($1, $2, 'Remote', 'https://agent.example.test/a2a',
               'bearer', 'ciphertext')`,
      [id, userId],
    );
    await expect(
      client.query(
        `INSERT INTO remote_agent
          (user_id, name, endpoint_url, credential_type,
           encrypted_credential)
         VALUES ($1, 'Broken', 'https://broken.example.test/a2a',
                 'api_key', 'ciphertext')`,
        [userId],
      ),
    ).rejects.toThrow();
    await expect(
      client.query(
        `INSERT INTO remote_agent (user_id, name, endpoint_url)
         VALUES ($1, 'Duplicate', 'https://agent.example.test/a2a')`,
        [userId],
      ),
    ).rejects.toThrow();
    await client.query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    const remaining = await client.query(
      `SELECT count(*)::int AS count FROM remote_agent WHERE id = $1`,
      [id],
    );
    expect(remaining.rows[0].count).toBe(0);
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
