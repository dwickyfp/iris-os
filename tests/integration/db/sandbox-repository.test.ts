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
const loadSandboxRepositoryModule = () =>
  import("lib/db/pg/repositories/sandbox-repository.pg");
const loadArtifactRepositoryModule = () =>
  import("lib/db/pg/repositories/artifact-repository.pg");
type SandboxRepositoryModule = Awaited<
  ReturnType<typeof loadSandboxRepositoryModule>
>;
type ArtifactRepositoryModule = Awaited<
  ReturnType<typeof loadArtifactRepositoryModule>
>;
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
  test("a refresh before expiry claim keeps the live session active", async () => {
    const { userId, rootRunId } = await createRunTree();
    const expiredAt = new Date("2000-01-01T00:00:00.000Z");
    const sessionId = await createSession(userId, rootRunId, expiredAt);
    const refreshedAt = new Date();

    await expect(
      repository.touchSession(
        sessionId,
        refreshedAt,
        new Date(refreshedAt.getTime() + 60_000),
      ),
    ).resolves.toBe(true);
    await expect(
      repository.claimExpiredSessions(
        refreshedAt,
        10,
        new Date(refreshedAt.getTime() + 30_000),
      ),
    ).resolves.toEqual([]);

    const state = await client.query(
      `SELECT status FROM sandbox_session WHERE id = $1`,
      [sessionId],
    );
    expect(state.rows[0]).toEqual({ status: "active" });
  });

  test("an expiry claim fences touch and execution", async () => {
    const { userId, rootRunId } = await createRunTree();
    const expiredAt = new Date("2000-01-01T00:00:00.000Z");
    const sessionId = await createSession(userId, rootRunId, expiredAt);
    const claimedAt = new Date();
    const claimed = await repository.claimExpiredSessions(
      claimedAt,
      10,
      new Date(claimedAt.getTime() + 30_000),
    );

    expect(claimed.map((session) => session.id)).toContain(sessionId);
    await expect(
      repository.touchSession(
        sessionId,
        claimedAt,
        new Date(claimedAt.getTime() + 60_000),
      ),
    ).resolves.toBe(false);
    await expect(
      repository.reserveExecution(
        executionRecord(sessionId, rootRunId, claimedAt),
        1_000,
      ),
    ).resolves.toBe(false);
    await repository.finishSession(sessionId, "destroyed", {
      destroyedAt: new Date(),
    });
  });

  test("an execution started before claim keeps its session active", async () => {
    const { userId, rootRunId } = await createRunTree();
    const expiredAt = new Date("2000-01-01T00:00:00.000Z");
    const sessionId = await createSession(userId, rootRunId, expiredAt);
    const execution = executionRecord(sessionId, rootRunId, new Date());
    await expect(repository.reserveExecution(execution, 1_000)).resolves.toBe(
      true,
    );
    await expect(
      repository.startExecution(
        execution.id,
        execution.reservationToken,
        new Date(),
        new Date(Date.now() + 60_000),
      ),
    ).resolves.toBe(true);

    await expect(
      repository.claimExpiredSessions(
        new Date(),
        10,
        new Date(Date.now() + 30_000),
      ),
    ).resolves.toEqual([]);
    await expect(
      repository.settleExecution(
        execution.id,
        execution.reservationToken,
        10,
        10,
        new Date(),
      ),
    ).resolves.toBe(true);
    await expect(
      repository.finishExecution(execution.id, {
        status: "succeeded",
        durationMs: 10,
        observedWallDurationMs: 10,
        exitCode: 0,
        completedAt: new Date(),
      }),
    ).resolves.toBe(true);
    await repository.finishSession(sessionId, "destroyed", {
      destroyedAt: new Date(),
    });
  });

  test("two reapers claim an expired session once and retry after lease expiry", async () => {
    const { userId, rootRunId } = await createRunTree();
    const expiredAt = new Date("2000-01-01T00:00:00.000Z");
    const sessionId = await createSession(userId, rootRunId, expiredAt);
    const claimedAt = new Date();
    const retryAt = new Date(claimedAt.getTime() + 30_000);

    const claims = await Promise.all([
      repository.claimExpiredSessions(claimedAt, 1, retryAt),
      repository.claimExpiredSessions(claimedAt, 1, retryAt),
    ]);
    expect(claims.flat().map((session) => session.id)).toEqual([sessionId]);
    await expect(
      repository.claimExpiredSessions(claimedAt, 1, retryAt),
    ).resolves.toEqual([]);
    await expect(
      repository.claimExpiredSessions(
        new Date(retryAt.getTime() + 1),
        1,
        new Date(retryAt.getTime() + 30_001),
      ),
    ).resolves.toEqual([expect.objectContaining({ id: sessionId })]);
    await repository.finishSession(sessionId, "destroyed", {
      destroyedAt: new Date(),
    });
  });

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
        new Date(),
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
    const staleAt = new Date("2000-01-01T00:00:00.000Z");
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

  test("reconciliation lists active, creating, and inventoried terminal sessions", async () => {
    const { userId, rootRunId, childRunId, grandchildRunId } =
      await createRunTree();
    const now = new Date();
    const activeId = await createSession(userId, rootRunId, now);
    const creatingId = randomUUID();
    const terminalId = randomUUID();
    await client.query(
      `INSERT INTO sandbox_session
        (id, run_id, user_id, provider, provider_instance_id, creator_token,
         profile, status, last_used_at, expires_at, created_at, destroyed_at)
       VALUES ($1, $2, $4, 'iris-runner', NULL, gen_random_uuid(), $5::json,
               'creating', $6, $7, $6, NULL),
              ($3, $8, $4, 'iris-runner', 'terminal-container', NULL, $5::json,
               'destroyed', $6, $7, $6, $6)`,
      [
        creatingId,
        childRunId,
        terminalId,
        userId,
        JSON.stringify(profile()),
        now,
        new Date(now.getTime() + 60_000),
        grandchildRunId,
      ],
    );

    const sessions = await repository.listSessionsForReconciliation(
      "iris-runner",
      ["terminal-container"],
    );

    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([activeId, creatingId, terminalId]),
    );
    expect(
      sessions
        .filter((session) =>
          new Set<string>([activeId, creatingId, terminalId]).has(session.id),
        )
        .every((session) => session.rootRunId === rootRunId),
    ).toBe(true);
  });

  test("adopts a crash-created container with effective limits", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const claim = await repository.claimSession(
      sessionRecord(userId, rootRunId, now),
      randomUUID(),
    );
    const effectiveProfile = {
      ...profile(),
      cpuMillis: 500,
      memoryMb: 256,
      diskMb: 512,
      pidsLimit: 32,
    };

    await expect(
      repository.reconcileSession({
        id: claim.session.id,
        rootRunId,
        provider: "iris-runner",
        providerInstanceId: "crash-container",
        profile: effectiveProfile,
        expiresAt: new Date(now.getTime() + 30_000),
        creatorMayBeLive: false,
        reconciledAt: now,
      }),
    ).resolves.toBe("active");
    const state = await client.query(
      `SELECT status, provider_instance_id, creator_token, profile
       FROM sandbox_session WHERE id = $1`,
      [claim.session.id],
    );
    expect(state.rows[0]).toMatchObject({
      status: "active",
      provider_instance_id: "crash-container",
      creator_token: null,
      profile: effectiveProfile,
    });
  });

  test("rejects reconciliation when cancellation or identity mismatch wins", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const claim = await repository.claimSession(
      sessionRecord(userId, rootRunId, now),
      randomUUID(),
    );
    await client.query(
      `UPDATE agent_run SET cancel_requested_at = NOW() WHERE id = $1`,
      [rootRunId],
    );
    const base = {
      id: claim.session.id,
      rootRunId,
      provider: "iris-runner",
      providerInstanceId: "candidate-container",
      profile: profile(),
      expiresAt: new Date(now.getTime() + 30_000),
      creatorMayBeLive: false,
      reconciledAt: now,
    };

    await expect(repository.reconcileSession(base)).resolves.toBe("rejected");
    await client.query(
      `UPDATE agent_run SET cancel_requested_at = NULL WHERE id = $1`,
      [rootRunId],
    );
    await expect(
      repository.reconcileSession({ ...base, rootRunId: randomUUID() }),
    ).resolves.toBe("rejected");
    await expect(
      repository.reconcileSession({
        ...base,
        profile: { ...base.profile, id: "wrong-profile" },
      }),
    ).resolves.toBe("rejected");
  });

  test("serializes creator activation and reconciliation takeover", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const creatorToken = randomUUID();
    const claim = await repository.claimSession(
      sessionRecord(userId, rootRunId, now),
      creatorToken,
    );
    const expiresAt = new Date(now.getTime() + 30_000);

    const [creator, reconciler] = await Promise.all([
      repository.activateSession(
        claim.session.id,
        creatorToken,
        "shared-container",
        expiresAt,
        now,
        profile(),
      ),
      repository.reconcileSession({
        id: claim.session.id,
        rootRunId,
        provider: "iris-runner",
        providerInstanceId: "shared-container",
        profile: profile(),
        expiresAt,
        creatorMayBeLive: false,
        reconciledAt: now,
      }),
    ]);

    expect(creator).toBe(true);
    expect(reconciler).toBe("active");
    const state = await client.query(
      `SELECT status, provider_instance_id FROM sandbox_session WHERE id = $1`,
      [claim.session.id],
    );
    expect(state.rows[0]).toEqual({
      status: "active",
      provider_instance_id: "shared-container",
    });
  });

  test("marks a matching active session lost and terminalizes running execution", async () => {
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const sessionId = await createSession(userId, rootRunId, now);
    const inventoryCapturedAt = new Date(now.getTime() + 24 * 60 * 60 * 1_000);
    const execution = executionRecord(sessionId, rootRunId, now);
    await repository.reserveExecution(execution, 1_000);
    await repository.startExecution(
      execution.id,
      execution.reservationToken,
      now,
      new Date(now.getTime() + 61_000),
    );

    await expect(
      repository.markSessionLost(
        sessionId,
        "wrong-instance",
        inventoryCapturedAt,
        new Date(),
      ),
    ).resolves.toBe(false);
    await expect(
      repository.markSessionLost(
        sessionId,
        "test-instance",
        inventoryCapturedAt,
        new Date(),
      ),
    ).resolves.toBe(true);

    const state = await client.query(
      `SELECT s.status AS session_status, s.error_code AS session_error,
              e.status AS execution_status, e.error_code AS execution_error,
              e.completed_at IS NOT NULL AS execution_completed,
              b.reserved_compute_ms, b.committed_compute_ms
       FROM sandbox_session s
       JOIN sandbox_execution e ON e.session_id = s.id
       JOIN sandbox_run_compute_budget b ON b.run_id = s.run_id
       WHERE s.id = $1`,
      [sessionId],
    );
    expect(state.rows[0]).toEqual({
      session_status: "failed",
      session_error: "SANDBOX_SESSION_LOST",
      execution_status: "failed",
      execution_error: "SANDBOX_SESSION_LOST",
      execution_completed: true,
      reserved_compute_ms: 0,
      committed_compute_ms: 1_000,
    });
  });

  test("loss CAS rejects a session activated after the inventory snapshot", async () => {
    const { userId, rootRunId } = await createRunTree();
    const createdAt = new Date("2026-08-22T10:00:00.000Z");
    const snapshotAt = new Date(createdAt.getTime() + 1_000);
    const activatedAt = new Date(snapshotAt.getTime() + 1_000);
    const creatorToken = randomUUID();
    const claim = await repository.claimSession(
      sessionRecord(userId, rootRunId, createdAt),
      creatorToken,
    );
    await expect(
      repository.activateSession(
        claim.session.id,
        creatorToken,
        "late-container",
        new Date(activatedAt.getTime() + 60_000),
        activatedAt,
      ),
    ).resolves.toBe(true);

    await expect(
      repository.markSessionLost(
        claim.session.id,
        "late-container",
        snapshotAt,
        new Date(activatedAt.getTime() + 1_000),
      ),
    ).resolves.toBe(false);
    const state = await client.query(
      `SELECT status, provider_instance_id FROM sandbox_session WHERE id = $1`,
      [claim.session.id],
    );
    expect(state.rows[0]).toEqual({
      status: "active",
      provider_instance_id: "late-container",
    });
  });

  test("retains exact lookup identity only while session and run remain live", async () => {
    const first = await createRunTree();
    const firstSessionId = await createSession(
      first.userId,
      first.rootRunId,
      new Date(),
    );
    const exact = {
      id: firstSessionId,
      rootRunId: first.rootRunId,
      provider: "iris-runner",
      providerInstanceId: "test-instance",
      profile: profile(),
    };

    await expect(repository.retainSessionAfterLookup(exact)).resolves.toBe(
      true,
    );
    await expect(
      repository.retainSessionAfterLookup({
        ...exact,
        providerInstanceId: "wrong-instance",
      }),
    ).resolves.toBe(false);
    await expect(
      repository.retainSessionAfterLookup({
        ...exact,
        profile: { ...exact.profile, id: "wrong-profile" },
      }),
    ).resolves.toBe(false);
    await client.query(
      `UPDATE agent_run SET cancel_requested_at = NOW() WHERE id = $1`,
      [first.rootRunId],
    );
    await expect(repository.retainSessionAfterLookup(exact)).resolves.toBe(
      false,
    );

    const second = await createRunTree();
    const secondSessionId = await createSession(
      second.userId,
      second.rootRunId,
      new Date(),
    );
    await client.query(
      `UPDATE agent_run
       SET status = 'failed', lease_token = NULL, lease_expires_at = NULL,
           completed_at = NOW()
       WHERE id = $1`,
      [second.rootRunId],
    );
    await expect(
      repository.retainSessionAfterLookup({
        ...exact,
        id: secondSessionId,
        rootRunId: second.rootRunId,
      }),
    ).resolves.toBe(false);
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
        now,
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
        now,
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
        JSON.stringify({
          executionSource: "workflow",
          workflowId: randomUUID(),
        }),
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
    await repository.reserveExecution(
      {
        id: executionId,
        sessionId,
        runId: rootRunId,
        status: "reserved",
        reservationToken,
        reservedComputeMs: 1_000,
        reservationExpiresAt: new Date(now.getTime() + 60_000),
      },
      5_000,
    );
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
    await client.query(
      `INSERT INTO root_run_budget_reservation
         (token, root_run_id, run_id, kind, amount, expires_at)
       SELECT 'sandbox:' || reservation_token::text, $1, $1,
              'sandbox_compute_ms', reserved_compute_ms, reservation_expires_at
       FROM sandbox_execution WHERE run_id = $1 AND status IN ('reserved', 'running')`,
      [rootRunId],
    );
    await client.query(
      `UPDATE root_run_budget SET reserved_sandbox_compute_ms = 700
       WHERE root_run_id = $1`,
      [rootRunId],
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

  test("independently reconciles stale executions for terminal sessions", async () => {
    await drainStaleExecutions();
    const { userId, rootRunId } = await createRunTree();
    const now = new Date();
    const rootSessionId = await createSession(userId, rootRunId, now);
    const reserved = await createExecution(
      rootSessionId,
      rootRunId,
      "reserved",
      300,
    );
    await expireExecutions([reserved.id]);
    await client.query(
      `UPDATE sandbox_session
       SET status = 'destroyed', destroyed_at = NOW()
       WHERE id = $1`,
      [rootSessionId],
    );

    await expect(
      repository.reconcileStaleExecutions(new Date(), 10),
    ).resolves.toBe(1);
    await expect(
      repository.reconcileStaleExecutions(new Date(), 10),
    ).resolves.toBe(0);

    const executions = await client.query(
      `SELECT run_id, status, error_code, duration_ms, charged_at IS NOT NULL AS charged
       FROM sandbox_execution WHERE run_id = $1`,
      [rootRunId],
    );
    expect(executions.rows).toEqual(
      expect.arrayContaining([
        {
          run_id: rootRunId,
          status: "failed",
          error_code: "SANDBOX_RESERVATION_EXPIRED",
          duration_ms: null,
          charged: false,
        },
      ]),
    );
    const runBudgets = await client.query(
      `SELECT run_id, reserved_compute_ms, committed_compute_ms
       FROM sandbox_run_compute_budget WHERE run_id = $1`,
      [rootRunId],
    );
    expect(runBudgets.rows).toEqual(
      expect.arrayContaining([
        {
          run_id: rootRunId,
          reserved_compute_ms: 0,
          committed_compute_ms: 0,
        },
      ]),
    );
    const rootBudget = await client.query(
      `SELECT reserved_sandbox_compute_ms, committed_sandbox_compute_ms
       FROM root_run_budget WHERE root_run_id = $1`,
      [rootRunId],
    );
    expect(rootBudget.rows[0]).toEqual({
      reserved_sandbox_compute_ms: 0,
      committed_sandbox_compute_ms: 0,
    });
  });

  test("concurrent stale execution reapers settle each reservation once", async () => {
    await drainStaleExecutions();
    const first = await createRunTree();
    const second = await createRunTree();
    const firstSessionId = await createSession(
      first.userId,
      first.rootRunId,
      new Date(),
    );
    const secondSessionId = await createSession(
      second.userId,
      second.rootRunId,
      new Date(),
    );
    const reserved = await createExecution(
      firstSessionId,
      first.rootRunId,
      "reserved",
      250,
    );
    const running = await createExecution(
      secondSessionId,
      second.rootRunId,
      "running",
      350,
    );
    await expireExecutions([reserved.id, running.id]);

    const results = await Promise.all([
      repository.reconcileStaleExecutions(new Date(), 10),
      repository.reconcileStaleExecutions(new Date(), 10),
    ]);

    const state = await client.query(
      `SELECT b.reserved_compute_ms, b.committed_compute_ms,
              r.reserved_sandbox_compute_ms, r.committed_sandbox_compute_ms,
              count(*) FILTER (WHERE x.state = 'committed')::int AS committed,
              count(*) FILTER (WHERE x.state = 'released')::int AS released
       FROM sandbox_run_compute_budget b
       JOIN root_run_budget r ON r.root_run_id = b.run_id
       JOIN root_run_budget_reservation x ON x.run_id = b.run_id
       WHERE b.run_id = ANY($1::uuid[])
       GROUP BY b.run_id, r.root_run_id`,
      [[first.rootRunId, second.rootRunId]],
    );
    expect(
      results.reduce((total, value) => total + value, 0),
      JSON.stringify({ results, state: state.rows }),
    ).toBe(2);
    expect(state.rows).toEqual(
      expect.arrayContaining([
        {
          reserved_compute_ms: 0,
          committed_compute_ms: 0,
          reserved_sandbox_compute_ms: 0,
          committed_sandbox_compute_ms: 0,
          committed: 0,
          released: 1,
        },
        {
          reserved_compute_ms: 0,
          committed_compute_ms: 350,
          reserved_sandbox_compute_ms: 0,
          committed_sandbox_compute_ms: 350,
          committed: 1,
          released: 0,
        },
      ]),
    );
  });

  test("cancellation racing stale reconciliation does not double-settle", async () => {
    await drainStaleExecutions();
    const { userId, rootRunId } = await createRunTree();
    const sessionId = await createSession(userId, rootRunId, new Date());
    const running = await createExecution(sessionId, rootRunId, "running", 500);
    await expireExecutions([running.id]);

    await Promise.all([
      repository.cancelSessionsByRun(rootRunId, "iris-runner", new Date()),
      repository.reconcileStaleExecutions(new Date(), 10),
    ]);
    await repository.reconcileStaleExecutions(new Date(), 10);

    const state = await client.query(
      `SELECT e.status, e.charged_at IS NOT NULL AS charged,
              b.reserved_compute_ms, b.committed_compute_ms,
              r.reserved_sandbox_compute_ms, r.committed_sandbox_compute_ms,
              x.state, x.committed_amount
       FROM sandbox_execution e
       JOIN sandbox_run_compute_budget b ON b.run_id = e.run_id
       JOIN root_run_budget r ON r.root_run_id = e.run_id
       JOIN root_run_budget_reservation x
         ON x.token = 'sandbox:' || e.reservation_token::text
       WHERE e.session_id = $1`,
      [sessionId],
    );
    expect(state.rows[0]).toMatchObject({
      charged: true,
      reserved_compute_ms: 0,
      committed_compute_ms: 500,
      reserved_sandbox_compute_ms: 0,
      committed_sandbox_compute_ms: 500,
      state: "committed",
      committed_amount: 500,
    });
    expect(["cancelled", "timed_out"]).toContain(state.rows[0].status);
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
  await client.query(
    `INSERT INTO root_run_budget
       (root_run_id, max_steps, max_tokens, max_duration_ms, max_tool_calls,
        max_delegations, max_delegation_depth, max_parallel_children,
        max_sandbox_compute_ms)
     VALUES ($1, 10, 50000, 300000, 32, 8, 3, 8, 1000)`,
    [rootRunId],
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

async function createExecution(
  sessionId: string,
  runId: string,
  status: "reserved" | "running",
  reservedComputeMs: number,
) {
  const now = new Date();
  const execution = {
    id: randomUUID(),
    sessionId,
    runId,
    status: "reserved" as const,
    reservationToken: randomUUID(),
    reservedComputeMs,
    reservationExpiresAt: new Date(now.getTime() + 60_000),
  };
  if (!(await repository.reserveExecution(execution, 1_000)))
    throw new Error("TEST_SANDBOX_RESERVATION_FAILED");
  if (status === "running") {
    if (
      !(await repository.startExecution(
        execution.id,
        execution.reservationToken,
        now,
        new Date(now.getTime() + 60_000),
      ))
    )
      throw new Error("TEST_SANDBOX_START_FAILED");
  }
  return execution;
}

async function expireExecutions(ids: string[]) {
  const expired = await client.query(
    `UPDATE sandbox_execution
     SET reservation_expires_at = CURRENT_TIMESTAMP - interval '1 second',
         settlement_deadline_at = CASE
           WHEN status = 'running'
             THEN CURRENT_TIMESTAMP - interval '1 second'
           ELSE NULL
         END
     WHERE id = ANY($1::uuid[])
     RETURNING id`,
    [ids],
  );
  expect(expired.rowCount).toBe(ids.length);
}

async function drainStaleExecutions() {
  while ((await repository.reconcileStaleExecutions(new Date(), 500)) > 0) {
    // Integration tests share one schema, so global reaper fixtures need draining.
  }
}
