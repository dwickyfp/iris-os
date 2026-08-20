import { randomUUID } from "node:crypto";
import type { SandboxSessionRecord } from "lib/sandbox";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;

vi.mock("server-only", () => ({}));

const client = new Client({ connectionString });
type SandboxRepositoryModule = typeof import("lib/db/pg/repositories/sandbox-repository.pg");
type ArtifactRepositoryModule = typeof import("lib/db/pg/repositories/artifact-repository.pg");
let repository: SandboxRepositoryModule["pgSandboxRepository"];
let artifactRepository: ArtifactRepositoryModule["pgArtifactRepository"];

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
  repository = (await import("lib/db/pg/repositories/sandbox-repository.pg"))
    .pgSandboxRepository;
  artifactRepository = (
    await import("lib/db/pg/repositories/artifact-repository.pg")
  ).pgArtifactRepository;
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("sandbox repository concurrency", () => {
  test("grants one distributed creator claim and fences activation after cancellation", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const record: SandboxSessionRecord = {
      id: randomUUID(),
      runId: rootRunId,
      userId,
      provider: "iris-runner",
      profile: profile(),
      status: "creating",
      lastUsedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    };
    const tokenA = randomUUID();
    const tokenB = randomUUID();

    const [first, second] = await Promise.all([
      repository.claimSession(record, tokenA),
      repository.claimSession({ ...record, id: randomUUID() }, tokenB),
    ]);
    expect([first.claimed, second.claimed].sort()).toEqual([false, true]);
    const winner = first.claimed ? tokenA : tokenB;
    const sessionId = first.claimed ? first.session.id : second.session.id;
    const cancelled = await repository.cancelSessionsByRun(
      rootRunId,
      "iris-runner",
      new Date(),
    );

    expect(cancelled).toHaveLength(1);
    await expect(
      repository.activateSession(
        sessionId,
        winner,
        "late-container",
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toBe(false);
    const state = await client.query(
      `SELECT status, error_code, provider_instance_id
       FROM sandbox_session WHERE run_id = $1`,
      [rootRunId],
    );
    expect(state.rows[0]).toEqual({
      status: "cancelled",
      error_code: "RUN_CANCELLED",
      provider_instance_id: null,
    });
  });

  test("cancels creating and active sessions across every nonterminal descendant", async () => {
    const { userId, rootRunId, childRunId, grandchildRunId } =
      await createRunTree();
    const terminalRunId = randomUUID();
    await client.query(
      `INSERT INTO agent_run (id, user_id, root_run_id, status)
       VALUES ($1, $2, $3, 'queued')`,
      [terminalRunId, userId, rootRunId],
    );
    const now = new Date();
    for (const [runId, status] of [
      [rootRunId, "creating"],
      [childRunId, "active"],
      [grandchildRunId, "destroying"],
      [terminalRunId, "destroyed"],
    ] as const) {
      await client.query(
        `INSERT INTO sandbox_session
          (id, run_id, user_id, provider, provider_instance_id, profile,
           status, last_used_at, expires_at, created_at)
         VALUES ($1, $2, $3, 'iris-runner', $4, $5::json, $6, $7, $8, $7)`,
        [
          randomUUID(),
          runId,
          userId,
          status === "active" ? "active-container" : null,
          JSON.stringify(profile()),
          status,
          now,
          new Date(now.getTime() + 60_000),
        ],
      );
    }

    const cancelled = await repository.cancelSessionsByRootRun(
      rootRunId,
      "iris-runner",
      new Date(),
    );

    expect(cancelled.map((session) => session.runId).sort()).toEqual(
      [rootRunId, childRunId, grandchildRunId].sort(),
    );
    const states = await client.query(
      `SELECT run_id, status FROM sandbox_session ORDER BY run_id`,
    );
    expect(states.rows).toContainEqual({
      run_id: terminalRunId,
      status: "destroyed",
    });
    expect(states.rows.filter((row) => row.run_id !== terminalRunId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "cancelled" }),
        expect.objectContaining({ status: "cancelled" }),
        expect.objectContaining({ status: "cancelled" }),
      ]),
    );
  });

  test("reclaims a stale session without changing its referenced primary key", async () => {
    const { userId, rootRunId } = await createRunTree();
    const staleSessionId = randomUUID();
    const executionId = randomUUID();
    const staleAt = new Date(0);
    await client.query(
      `INSERT INTO sandbox_session
        (id, run_id, user_id, provider, profile, status, creator_token,
         last_used_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'iris-runner', $4::json, 'creating', $5,
               $6, $6, $6)`,
      [
        staleSessionId,
        rootRunId,
        userId,
        JSON.stringify(profile()),
        randomUUID(),
        staleAt,
      ],
    );
    await client.query(
       `INSERT INTO sandbox_execution
        (id, session_id, run_id, status, reservation_token,
         reserved_compute_ms, reservation_expires_at, error_code, started_at,
         completed_at)
       VALUES ($1, $2, $3, 'cancelled', gen_random_uuid(), 1000, $4,
               'OLD', $4, $4)`,
      [executionId, staleSessionId, rootRunId, staleAt],
    );
    const now = new Date();
    const reclaimed = await repository.claimSession(
      {
        id: randomUUID(),
        runId: rootRunId,
        userId,
        provider: "iris-runner",
        profile: profile(),
        status: "creating",
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      },
      randomUUID(),
    );

    expect(reclaimed).toMatchObject({ claimed: true });
    expect(reclaimed.session.id).toBe(staleSessionId);
    const history = await client.query(
      `SELECT session_id FROM sandbox_execution WHERE id = $1`,
      [executionId],
    );
    expect(history.rows[0].session_id).toBe(staleSessionId);
  });

  test("refuses a session claim after durable cancellation", async () => {
    const { userId, rootRunId, childRunId } = await createRunTree();
    await client.query(
      `UPDATE agent_run
       SET cancel_requested_at = NOW()
       WHERE id = $1`,
      [rootRunId],
    );
    const now = new Date();

    const claim = await repository.claimSession(
      sessionRecord(userId, childRunId, now),
      randomUUID(),
    );

    expect(claim).toMatchObject({
      claimed: false,
      session: { status: "cancelled", errorCode: "RUN_CANCELLED" },
    });
    const persisted = await client.query(
      `SELECT count(*)::int AS count FROM sandbox_session WHERE run_id = $1`,
      [childRunId],
    );
    expect(persisted.rows[0].count).toBe(0);
  });

  test("refuses activation after only authoritative run cancellation is persisted", async () => {
    const { userId, childRunId } = await createRunTree();
    const now = new Date();
    const creatorToken = randomUUID();
    const claim = await repository.claimSession(
      sessionRecord(userId, childRunId, now),
      creatorToken,
    );
    expect(claim.claimed).toBe(true);
    await client.query(
      `UPDATE agent_run
       SET cancel_requested_at = NOW()
       WHERE id = $1`,
      [childRunId],
    );

    await expect(
      repository.activateSession(
        claim.session.id,
        creatorToken,
        "late-container",
        new Date(now.getTime() + 60_000),
      ),
    ).resolves.toBe(false);
    const state = await client.query(
      `SELECT status, creator_token, provider_instance_id
       FROM sandbox_session WHERE id = $1`,
      [claim.session.id],
    );
    expect(state.rows[0]).toEqual({
      status: "creating",
      creator_token: creatorToken,
      provider_instance_id: null,
    });
  });

  test("refuses activation after linked automation cancellation is persisted", async () => {
    const { userId, rootRunId } = await createRunTree();
    const automationId = randomUUID();
    const automationRunId = randomUUID();
    await client.query(
      `INSERT INTO automation
         (id, user_id, name, status, trigger_type, target_type, target_id,
          approval_policy)
       VALUES ($1, $2, 'Sandbox activation', 'active', 'manual', 'workflow',
               $3, 'never')`,
      [automationId, userId, randomUUID()],
    );
    await client.query(
      `INSERT INTO automation_run
         (id, automation_id, user_id, idempotency_key, status, scheduled_for)
       VALUES ($1, $2, $3, $4, 'running', NOW())`,
      [automationRunId, automationId, userId, randomUUID()],
    );
    await client.query(
      `UPDATE agent_run
       SET context = $2::json
       WHERE id = $1`,
      [
        rootRunId,
        JSON.stringify({
          executionSource: "automation-workflow",
          automationRunId,
        }),
      ],
    );
    const now = new Date();
    const creatorToken = randomUUID();
    const claim = await repository.claimSession(
      sessionRecord(userId, rootRunId, now),
      creatorToken,
    );
    expect(claim.claimed).toBe(true);
    await client.query(
      `UPDATE automation_run
       SET cancel_requested_at = NOW()
       WHERE id = $1`,
      [automationRunId],
    );

    await expect(
      repository.activateSession(
        claim.session.id,
        creatorToken,
        "late-automation-container",
        new Date(now.getTime() + 60_000),
      ),
    ).resolves.toBe(false);
  });

  test("refuses direct workflow session claims after the canonical run is terminal", async () => {
    const { userId, rootRunId } = await createRunTree();
    await client.query(
      `UPDATE agent_run
       SET status = 'succeeded', completed_at = NOW(),
           lease_token = NULL, lease_expires_at = NULL,
           context = $2::json
       WHERE id = $1`,
      [
        rootRunId,
        JSON.stringify({ executionSource: "workflow", workflowId: randomUUID() }),
      ],
    );

    const claim = await repository.claimSession(
      sessionRecord(userId, rootRunId, new Date()),
      randomUUID(),
    );

    expect(claim).toMatchObject({ claimed: false });
  });

  test("cancellation between session activation and reservation fences execution", async () => {
    const { userId, rootRunId, childRunId } = await createRunTree();
    const now = new Date();
    const sessionId = await createSession(userId, childRunId, now);
    await client.query(
      `UPDATE agent_run
       SET cancel_requested_at = NOW()
       WHERE id = $1`,
      [rootRunId],
    );

    const reserved = await repository.reserveExecution(
      executionRecord(sessionId, childRunId, now),
      1_000,
    );

    expect(reserved).toBe(false);
    const state = await client.query(
      `SELECT
         (SELECT count(*)::int FROM sandbox_execution WHERE run_id = $1)
           AS execution_count,
         (SELECT count(*)::int FROM sandbox_run_compute_budget WHERE run_id = $1)
           AS budget_count`,
      [childRunId],
    );
    expect(state.rows[0]).toEqual({ execution_count: 0, budget_count: 0 });
  });

  test("automation cancellation fences its canonical agent run reservation", async () => {
    const { userId, rootRunId } = await createRunTree();
    const automationId = randomUUID();
    const automationRunId = randomUUID();
    await client.query(
      `INSERT INTO automation
         (id, user_id, name, status, trigger_type, target_type, target_id,
          approval_policy)
       VALUES ($1, $2, 'Sandbox automation', 'active', 'manual', 'workflow',
               $3, 'never')`,
      [automationId, userId, randomUUID()],
    );
    await client.query(
      `INSERT INTO automation_run
         (id, automation_id, user_id, idempotency_key, status, scheduled_for,
          cancel_requested_at)
       VALUES ($1, $2, $3, $4, 'running', NOW(), NOW())`,
      [automationRunId, automationId, userId, randomUUID()],
    );
    await client.query(
      `UPDATE agent_run
       SET context = $2::json
       WHERE id = $1`,
      [
        rootRunId,
        JSON.stringify({
          executionSource: "automation-workflow",
          automationRunId,
        }),
      ],
    );
    const now = new Date();
    const sessionId = await createSession(userId, rootRunId, now);

    await expect(
      repository.reserveExecution(
        executionRecord(sessionId, rootRunId, now),
        1_000,
      ),
    ).resolves.toBe(false);
  });

  test("allows exactly one terminal execution transition", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const sessionId = randomUUID();
    const executionId = randomUUID();
    await client.query(
      `INSERT INTO sandbox_session
        (id, run_id, user_id, provider, provider_instance_id, profile, status,
         last_used_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'iris-runner', 'test-instance', $4::json, 'active',
               $5, $6, $5)`,
      [
        sessionId,
        rootRunId,
        userId,
        JSON.stringify(profile()),
        now,
        new Date(now.getTime() + 60_000),
      ],
    );
    const reservationToken = randomUUID();
    await repository.reserveExecution({
      id: executionId,
      sessionId,
      runId: rootRunId,
      status: "reserved",
      reservationToken,
      reservedComputeMs: 1_000,
      reservationExpiresAt: new Date(now.getTime() + 60_000),
    }, 5_000);
    await repository.startExecution(
      executionId,
      reservationToken,
      now,
      new Date(now.getTime() + 61_000),
    );

    const results = await Promise.all([
      repository.finishExecution(executionId, {
        status: "cancelled",
        durationMs: 0,
        errorCode: "RUN_CANCELLED",
        completedAt: new Date(),
      }),
      repository.finishExecution(executionId, {
        status: "succeeded",
        durationMs: 10,
        observedWallDurationMs: 10,
        exitCode: 0,
        completedAt: new Date(),
      }),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  test("atomically rejects aggregate reservations across repository instances", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const sessionId = await createSession(userId, rootRunId, now);
    const reserve = (id: string) =>
      repository.reserveExecution(
        {
          id,
          sessionId,
          runId: rootRunId,
          status: "reserved",
          reservationToken: randomUUID(),
          reservedComputeMs: 700,
          reservationExpiresAt: new Date(now.getTime() + 60_000),
        },
        1_000,
      );

    const results = await Promise.allSettled([
      reserve(randomUUID()),
      reserve(randomUUID()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const budget = await client.query(
      `SELECT reserved_compute_ms, committed_compute_ms
       FROM sandbox_run_compute_budget WHERE run_id = $1`,
      [rootRunId],
    );
    expect(budget.rows[0]).toEqual({
      reserved_compute_ms: 700,
      committed_compute_ms: 0,
    });
  });

  test("persists cumulative usage across restart and settles once after cancellation", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const sessionId = await createSession(userId, rootRunId, now);
    const executionId = randomUUID();
    const reservationToken = randomUUID();
    await repository.reserveExecution(
      {
        id: executionId,
        sessionId,
        runId: rootRunId,
        status: "reserved",
        reservationToken,
        reservedComputeMs: 600,
        reservationExpiresAt: new Date(now.getTime() + 60_000),
      },
      1_000,
    );
    await repository.startExecution(
      executionId,
      reservationToken,
      now,
      new Date(now.getTime() + 61_000),
    );
    await repository.cancelSessionsByRun(rootRunId, "iris-runner", new Date());

    await expect(
      repository.settleExecution(
        executionId,
        reservationToken,
        400,
        450,
        new Date(),
      ),
    ).resolves.toBe(true);
    await expect(
      repository.settleExecution(
        executionId,
        reservationToken,
        400,
        450,
        new Date(),
      ),
    ).resolves.toBe(false);
    await expect(
      repository.reserveExecution(
        {
          id: randomUUID(),
          sessionId,
          runId: rootRunId,
          status: "reserved",
          reservationToken: randomUUID(),
          reservedComputeMs: 601,
          reservationExpiresAt: new Date(Date.now() + 60_000),
        },
        1_000,
      ),
    ).resolves.toBe(false);
    const budget = await client.query(
      `SELECT reserved_compute_ms, committed_compute_ms
       FROM sandbox_run_compute_budget WHERE run_id = $1`,
      [rootRunId],
    );
    expect(budget.rows[0]).toEqual({
      reserved_compute_ms: 0,
      committed_compute_ms: 400,
    });
  });

  test("releases stale pre-execution leases and conservatively charges stale in-flight work", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const staleAt = new Date(0);
    const sessionId = await createSession(userId, rootRunId, now);
    await client.query(
      `INSERT INTO sandbox_run_compute_budget
         (run_id, max_compute_ms, reserved_compute_ms, committed_compute_ms)
       VALUES ($1, 1000, 700, 0)`,
      [rootRunId],
    );
    await client.query(
      `INSERT INTO sandbox_execution
         (id, session_id, run_id, status, reservation_token,
          reserved_compute_ms, reservation_expires_at)
       VALUES ($1, $2, $3, 'reserved', $4, 300, $5),
              ($6, $2, $3, 'running', $7, 400, $5)`,
      [
        randomUUID(),
        sessionId,
        rootRunId,
        randomUUID(),
        staleAt,
        randomUUID(),
        randomUUID(),
      ],
    );
    await client.query(
      `UPDATE sandbox_execution
       SET started_at = $2, settlement_deadline_at = $2
       WHERE run_id = $1 AND status = 'running'`,
      [rootRunId, staleAt],
    );

    await repository.reserveExecution(
      {
        id: randomUUID(),
        sessionId,
        runId: rootRunId,
        status: "reserved",
        reservationToken: randomUUID(),
        reservedComputeMs: 600,
        reservationExpiresAt: new Date(now.getTime() + 60_000),
      },
      1_000,
    );
    const budget = await client.query(
      `SELECT reserved_compute_ms, committed_compute_ms
       FROM sandbox_run_compute_budget WHERE run_id = $1`,
      [rootRunId],
    );
    expect(budget.rows[0]).toEqual({
      reserved_compute_ms: 600,
      committed_compute_ms: 400,
    });
  });

  test("claims cleanup for a storage key with no artifact row", async () => {
    const cleanupId = await artifactRepository.scheduleUploadCleanup(
      `orphan/${randomUUID()}`,
    );
    await client.query(
      `UPDATE artifact_cleanup SET next_attempt_at = NOW() - interval '1 second'
       WHERE id = $1`,
      [cleanupId],
    );

    const claimed = await artifactRepository.claimCleanup({
      before: new Date(),
      limit: 1,
    });
    expect(claimed).toEqual([
      expect.objectContaining({ cleanupId, artifactId: undefined }),
    ]);
  });
});

async function createRunTree() {
  const userId = randomUUID();
  const rootRunId = randomUUID();
  const childRunId = randomUUID();
  const grandchildRunId = randomUUID();
  await client.query(
    `INSERT INTO "user" (id, name, email, password)
     VALUES ($1, 'Sandbox Owner', $2, 'hash')`,
    [userId, `sandbox-${userId}@example.test`],
  );
  await client.query(
    `INSERT INTO agent_run
       (id, user_id, parent_run_id, root_run_id, depth, status, lease_token,
        lease_expires_at, absolute_deadline_at, attempt)
      VALUES ($1, $4, NULL, $1, 0, 'running', gen_random_uuid(),
              NOW() + interval '30 seconds', NOW() + interval '5 minutes', 1),
             ($2, $4, $1, $1, 1, 'running', gen_random_uuid(),
              NOW() + interval '30 seconds', NOW() + interval '5 minutes', 1),
             ($3, $4, $2, $1, 2, 'running', gen_random_uuid(),
              NOW() + interval '30 seconds', NOW() + interval '5 minutes', 1)`,
    [rootRunId, childRunId, grandchildRunId, userId],
  );
  return { userId, rootRunId, childRunId, grandchildRunId };
}

function profile() {
  return {
    id: "python",
    cpuMillis: 1_000,
    memoryMb: 512,
    diskMb: 1_024,
    executionTimeoutMs: 1_000,
    idleTimeoutMs: 60_000,
    network: "none" as const,
  };
}

async function createSession(userId: string, runId: string, now: Date) {
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO sandbox_session
      (id, run_id, user_id, provider, profile, status, last_used_at,
       expires_at, created_at, provider_instance_id)
      VALUES ($1, $2, $3, 'iris-runner', $4::json, 'active', $5, $6, $5,
              'test-instance')`,
    [
      sessionId,
      runId,
      userId,
      JSON.stringify(profile()),
      now,
      new Date(now.getTime() + 60_000),
    ],
  );
  return sessionId;
}

function sessionRecord(userId: string, runId: string, now: Date) {
  return {
    id: randomUUID(),
    runId,
    userId,
    provider: "iris-runner",
    profile: profile(),
    status: "creating" as const,
    lastUsedAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
    createdAt: now,
  };
}

function executionRecord(sessionId: string, runId: string, now: Date) {
  return {
    id: randomUUID(),
    sessionId,
    runId,
    status: "reserved" as const,
    reservationToken: randomUUID(),
    reservedComputeMs: 1_000,
    reservationExpiresAt: new Date(now.getTime() + 60_000),
  };
}
