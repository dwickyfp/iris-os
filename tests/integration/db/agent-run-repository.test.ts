import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");
process.env.POSTGRES_URL = connectionString;

vi.mock("server-only", () => ({}));

const client = new Client({ connectionString });
const loadRepositoryModule = () =>
  import("lib/db/pg/repositories/agent-run-repository.pg");
const loadSandboxRepositoryModule = () =>
  import("lib/db/pg/repositories/sandbox-repository.pg");
type RepositoryModule = Awaited<ReturnType<typeof loadRepositoryModule>>;
let repository: RepositoryModule["pgAgentRunRepository"];

beforeAll(async () => {
  await client.connect();
  await recreatePublicSchema(client);
  await applyMigrations(client);
  repository = (await import("lib/db/pg/repositories/agent-run-repository.pg"))
    .pgAgentRunRepository;
});

afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

describe("agent run durable external lifecycle", () => {
  test.each([
    ["succeeded", "DELEGATION_PARENT_TERMINAL"],
    ["budget_exhausted", "DELEGATION_PARENT_TERMINAL"],
    ["cancel_requested", "DELEGATION_PARENT_CANCELLING"],
    ["deadline_expired", "DELEGATION_PARENT_DEADLINE_EXPIRED"],
  ] as const)(
    "rejects delegation from a %s parent without consuming capacity",
    async (parentState, expectedError) => {
      const userId = randomUUID();
      const parentRunId = randomUUID();
      const agentId = randomUUID();
      await client.query(
        `INSERT INTO "user" (id, name, email, password)
         VALUES ($1, 'Rejected Parent Owner', $2, 'hash')`,
        [userId, `rejected-parent-${randomUUID()}@example.test`],
      );
      await client.query(
        `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
        [agentId, userId],
      );
      await repository.createRunning({
        id: parentRunId,
        userId,
        timeoutMs: 60_000,
      });
      await client.query(
        parentState === "cancel_requested"
          ? `UPDATE agent_run SET cancel_requested_at = NOW() WHERE id = $1`
          : parentState === "deadline_expired"
            ? `UPDATE agent_run SET absolute_deadline_at = NOW() - interval '1 second' WHERE id = $1`
            : `UPDATE agent_run
               SET status = $2, completed_at = NOW(), lease_token = NULL,
                   lease_expires_at = NULL
               WHERE id = $1`,
        parentState === "succeeded" || parentState === "budget_exhausted"
          ? [parentRunId, parentState]
          : [parentRunId],
      );
      const childRunId = randomUUID();

      await expect(
        repository.createDelegated({
          id: childRunId,
          delegationId: randomUUID(),
          userId,
          agentId,
          target: { kind: "local", agentId },
          parentRunId,
          objective: "Must not be queued",
          context: {},
          allowedTools: [],
          timeoutMs: 30_000,
          depth: 1,
          tokenBudget: 1_000,
          idempotencyKey: `${parentRunId}:rejected`,
          toolCallId: "rejected",
        }),
      ).rejects.toThrow(expectedError);

      const state = await client.query(
        `SELECT budget.committed_delegations, budget.reserved_children,
                count(child.id)::int AS children
         FROM root_run_budget budget
         LEFT JOIN agent_run child ON child.parent_run_id = budget.root_run_id
         WHERE budget.root_run_id = $1
         GROUP BY budget.root_run_id`,
        [parentRunId],
      );
      expect(state.rows[0]).toEqual({
        committed_delegations: 0,
        reserved_children: 0,
        children: 0,
      });
    },
  );

  test("returns an idempotent delegated replay after the parent becomes terminal", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const agentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Replay Owner', $2, 'hash')`,
      [userId, `replay-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
      [agentId, userId],
    );
    await repository.createRunning({
      id: parentRunId,
      userId,
      timeoutMs: 60_000,
    });
    const input = {
      id: childRunId,
      delegationId: randomUUID(),
      userId,
      agentId,
      target: { kind: "local" as const, agentId },
      parentRunId,
      objective: "Replay",
      context: {},
      allowedTools: [],
      timeoutMs: 30_000,
      depth: 1,
      tokenBudget: 1_000,
      idempotencyKey: `${parentRunId}:replay`,
      toolCallId: "replay",
    };
    const created = await repository.createDelegated(input);
    await client.query(
      `UPDATE agent_run
       SET status = 'failed', completed_at = NOW(), lease_token = NULL,
           lease_expires_at = NULL
       WHERE id = $1`,
      [parentRunId],
    );

    await expect(repository.createDelegated(input)).resolves.toEqual(created);
  });

  test("serializes delegated creation against parent cancellation", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const agentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Creation Cancellation Owner', $2, 'hash')`,
      [userId, `creation-cancellation-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
      [agentId, userId],
    );
    await repository.createRunning({ id: parentRunId, userId });
    const creationClient = new Client({ connectionString });
    const cancellationClient = new Client({ connectionString });
    await Promise.all([creationClient.connect(), cancellationClient.connect()]);
    await Promise.all([
      creationClient.query(`SET lock_timeout = '5s'`),
      cancellationClient.query(`SET lock_timeout = '5s'`),
    ]);
    const { createPgAgentRunRepository } = await loadRepositoryModule();
    const creationRepository = createPgAgentRunRepository(
      drizzle(creationClient) as never,
    );
    const cancellationRepository = createPgAgentRunRepository(
      drizzle(cancellationClient) as never,
    );
    const creation = creationRepository.createDelegated({
      id: childRunId,
      delegationId: randomUUID(),
      userId,
      agentId,
      target: { kind: "local", agentId },
      parentRunId,
      objective: "Race cancellation",
      context: {},
      allowedTools: [],
      timeoutMs: 60_000,
      depth: 1,
      tokenBudget: 1_000,
      idempotencyKey: `${parentRunId}:creation-cancellation`,
      toolCallId: "creation-cancellation",
    });
    const cancellation = cancellationRepository.requestCancellationTree(
      parentRunId,
      userId,
    );
    const [created, cancelled] = await Promise.allSettled([
      creation,
      cancellation,
    ]);
    await Promise.all([creationClient.end(), cancellationClient.end()]);

    expect(cancelled.status).toBe("fulfilled");
    if (created.status === "rejected") {
      expect(created.reason).toBeInstanceOf(Error);
      expect((created.reason as Error).message).toMatch(
        /DELEGATION_PARENT_(CANCELLING|TERMINAL)/,
      );
    }
    const state = await client.query(
      `SELECT parent.status AS parent_status,
              parent.cancel_requested_at AS parent_cancel_requested_at,
              child.status AS child_status,
              reservation.state AS reservation_state,
              join_row.completed_at AS join_completed_at
       FROM agent_run parent
       LEFT JOIN agent_run child ON child.parent_run_id = parent.id
       LEFT JOIN root_run_budget_reservation reservation
         ON reservation.token = 'child:' || child.id::text
       LEFT JOIN agent_run_join join_row ON join_row.child_run_id = child.id
       WHERE parent.id = $1`,
      [parentRunId],
    );
    expect(state.rows[0]).toMatchObject({
      parent_status: "running",
      parent_cancel_requested_at: expect.any(Date),
    });
    if (state.rows[0].child_status) {
      expect(state.rows[0]).toMatchObject({
        child_status: "cancelled",
        reservation_state: "released",
        join_completed_at: expect.any(Date),
      });
    }
  });

  test("serializes cancellation against sandbox reservation without deadlock", async () => {
    const userId = randomUUID();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const executionId = randomUUID();
    const reservationToken = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Sandbox Cancellation Owner', $2, 'hash')`,
      [userId, `sandbox-cancellation-${userId}@example.test`],
    );
    await repository.createRunning({ id: runId, userId });
    await client.query(
      `INSERT INTO sandbox_session
         (id, run_id, user_id, provider, provider_instance_id, profile, status,
          last_used_at, expires_at, created_at)
       VALUES ($1, $2, $3, 'iris-runner', 'test-instance', $4::json, 'active',
               NOW(), NOW() + interval '1 minute', NOW())`,
      [
        sessionId,
        runId,
        userId,
        JSON.stringify({
          id: "lock-order-test",
          runtime: "python",
          network: "none",
          cpu: 1,
          memoryMb: 128,
          pids: 32,
          timeoutMs: 30_000,
        }),
      ],
    );
    await installAgentRunPauseTrigger(
      runId,
      "OLD.cancel_requested_at IS NULL AND NEW.cancel_requested_at IS NOT NULL",
    );
    const cancellationClient = new Client({ connectionString });
    const sandboxClient = new Client({ connectionString });
    await Promise.all([cancellationClient.connect(), sandboxClient.connect()]);
    await Promise.all([
      cancellationClient.query(`SET lock_timeout = '5s'`),
      sandboxClient.query(`SET lock_timeout = '5s'`),
    ]);
    const { createPgAgentRunRepository } = await loadRepositoryModule();
    const { createPgSandboxRepository } = await loadSandboxRepositoryModule();
    const cancellationRepository = createPgAgentRunRepository(
      drizzle(cancellationClient) as never,
    );
    const sandboxRepository = createPgSandboxRepository(
      drizzle(sandboxClient) as never,
    );

    const cancellation = cancellationRepository.requestCancellationTree(
      runId,
      userId,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reservation = sandboxRepository.reserveExecution(
      {
        id: executionId,
        sessionId,
        runId,
        status: "reserved",
        reservationToken,
        reservedComputeMs: 1_000,
        reservationExpiresAt: new Date(Date.now() + 60_000),
      },
      1_000,
    );
    const [cancelled, reserved] = await Promise.all([
      cancellation,
      reservation,
    ]);
    await Promise.all([cancellationClient.end(), sandboxClient.end()]);

    expect(cancelled?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(reserved).toBe(false);
    const state = await client.query(
      `SELECT run.cancel_requested_at,
              budget.reserved_sandbox_compute_ms,
              budget.committed_sandbox_compute_ms,
              (SELECT count(*)::int FROM sandbox_execution execution
               WHERE execution.run_id = run.id) AS execution_count
       FROM agent_run run
       JOIN root_run_budget budget ON budget.root_run_id = run.root_run_id
       WHERE run.id = $1`,
      [runId],
    );
    expect(state.rows[0]).toEqual({
      cancel_requested_at: expect.any(Date),
      reserved_sandbox_compute_ms: 0,
      committed_sandbox_compute_ms: 0,
      execution_count: 0,
    });
  });

  test("serializes cancellation against child terminal settlement without deadlock", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const agentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Settlement Cancellation Owner', $2, 'hash')`,
      [userId, `settlement-cancellation-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
      [agentId, userId],
    );
    await repository.createRunning({ id: parentRunId, userId });
    await repository.createDelegated({
      id: childRunId,
      delegationId: randomUUID(),
      userId,
      agentId,
      target: { kind: "local", agentId },
      parentRunId,
      objective: "Settle while cancellation waits",
      context: {},
      allowedTools: [],
      timeoutMs: 60_000,
      depth: 1,
      tokenBudget: 1_000,
      idempotencyKey: `${parentRunId}:settlement-cancellation`,
      toolCallId: "settlement-cancellation",
    });
    const claimed = await repository.claimQueued(childRunId, 60_000);
    expect(claimed).not.toBeNull();
    await installAgentRunPauseTrigger(
      childRunId,
      "OLD.status = 'running' AND NEW.status = 'succeeded'",
    );
    const settlementClient = new Client({ connectionString });
    const cancellationClient = new Client({ connectionString });
    await Promise.all([
      settlementClient.connect(),
      cancellationClient.connect(),
    ]);
    await Promise.all([
      settlementClient.query(`SET lock_timeout = '5s'`),
      cancellationClient.query(`SET lock_timeout = '5s'`),
    ]);
    const { createPgAgentRunRepository } = await loadRepositoryModule();
    const settlementRepository = createPgAgentRunRepository(
      drizzle(settlementClient) as never,
    );
    const cancellationRepository = createPgAgentRunRepository(
      drizzle(cancellationClient) as never,
    );

    const settlement = settlementRepository.finishRunning(
      childRunId,
      claimed!.token,
      { status: "succeeded", result: { ok: true } },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancellation = cancellationRepository.requestCancellationTree(
      parentRunId,
      userId,
    );
    const [settled, cancelled] = await Promise.all([settlement, cancellation]);
    await Promise.all([settlementClient.end(), cancellationClient.end()]);

    expect(settled?.status).toBe("succeeded");
    expect(cancelled?.cancelRequestedAt).toBeInstanceOf(Date);
    const state = await client.query(
      `SELECT parent.cancel_requested_at, child.status AS child_status,
              reservation.state AS reservation_state,
              budget.reserved_children, budget.committed_children,
              join_row.completed_at, join_row.observation
       FROM agent_run parent
       JOIN agent_run child ON child.parent_run_id = parent.id
       JOIN root_run_budget budget ON budget.root_run_id = parent.root_run_id
       JOIN root_run_budget_reservation reservation
         ON reservation.token = 'child:' || child.id::text
       JOIN agent_run_join join_row ON join_row.child_run_id = child.id
       WHERE parent.id = $1 AND child.id = $2`,
      [parentRunId, childRunId],
    );
    expect(state.rows[0]).toMatchObject({
      cancel_requested_at: expect.any(Date),
      child_status: "succeeded",
      reservation_state: "committed",
      reserved_children: 0,
      committed_children: 1,
      completed_at: expect.any(Date),
      observation: { childRunId, status: "succeeded", result: { ok: true } },
    });
  });

  test("transitions working to waiting, observes child completion, and claims parent resume once", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const childAgentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Join Owner', $2, 'hash')`,
      [userId, `join-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
      [childAgentId, userId],
    );
    const parent = await repository.createRunning({
      id: parentRunId,
      userId,
      allowedTools: ["delegate_agent", "generate_report"],
      timeoutMs: 600_000,
    });
    await repository.createDelegated({
      id: childRunId,
      delegationId: randomUUID(),
      userId,
      agentId: childAgentId,
      target: { kind: "local", agentId: childAgentId },
      parentRunId,
      objective: "Research before the parent report",
      context: {},
      allowedTools: [],
      timeoutMs: 900_000,
      depth: 1,
      tokenBudget: 5_000,
      idempotencyKey: `${parentRunId}:delegate-call-1`,
      toolCallId: "delegate-call-1",
    });
    const deadlines = await client.query(
      `SELECT parent.absolute_deadline_at AS parent_deadline,
              child.absolute_deadline_at AS child_deadline
       FROM agent_run parent JOIN agent_run child ON child.id = $2
       WHERE parent.id = $1`,
      [parentRunId, childRunId],
    );
    expect(deadlines.rows[0].child_deadline.getTime()).toBeLessThanOrEqual(
      deadlines.rows[0].parent_deadline.getTime(),
    );

    const checkpoint = {
      delegationToolCallIds: ["delegate-call-1"],
      responseMessages: [{ role: "assistant", content: [] }],
      modelMessages: [{ role: "user", content: "Create a report" }],
      modelConfig: { provider: "fake", model: "fake-a2a" },
      authorizationRecipe: {
        threadId: randomUUID(),
        descriptorIds: ["builtin:generate_report"],
      },
      assistantMessageId: "assistant-root-1",
    };
    const beforeSuspend = await client.query(
      `SELECT run.status, run.lease_token, run.lease_expires_at,
              run.lease_expires_at > NOW() AS lease_active,
              count(join_row.child_run_id)::int AS joins
       FROM agent_run run
       LEFT JOIN agent_run_join join_row ON join_row.parent_run_id = run.id
       WHERE run.id = $1
       GROUP BY run.id`,
      [parentRunId],
    );
    expect(beforeSuspend.rows[0]).toMatchObject({
      status: "running",
      lease_token: parent.leaseToken,
      lease_active: true,
      joins: 1,
    });
    await expect(
      repository.suspendParent(parentRunId, parent.leaseToken!, checkpoint),
    ).resolves.toMatchObject({
      status: "waiting_external",
      waitingReason: "DELEGATED_CHILDREN",
    });
    const childLease = await repository.claimQueued(childRunId, 30_000);
    expect(childLease).not.toBeNull();
    await expect(
      repository.finishRunning(childRunId, childLease!.token, {
        status: "succeeded",
        result: { facts: ["joined"] },
      }),
    ).resolves.toMatchObject({ status: "succeeded" });

    const joined = await client.query(
      `SELECT observation, completed_at FROM agent_run_join
       WHERE child_run_id = $1`,
      [childRunId],
    );
    expect(joined.rows[0]).toMatchObject({
      observation: { status: "succeeded", result: { facts: ["joined"] } },
      completed_at: expect.any(Date),
    });

    const resumeDispatch = await client.query(
      `SELECT generation, dispatched_at
       FROM agent_run_resume_dispatch WHERE parent_run_id = $1`,
      [parentRunId],
    );
    expect(resumeDispatch.rows[0]).toMatchObject({
      generation: 1,
      dispatched_at: null,
    });
    const claimed = await repository.claimParentResume(parentRunId, 30_000);
    expect(claimed).toMatchObject({
      token: expect.any(String),
      run: { status: "running" },
      checkpoint: { generation: 1, assistantMessageId: "assistant-root-1" },
      joins: [
        {
          toolCallId: "delegate-call-1",
          childRunId,
          observation: {
            status: "succeeded",
            result: { facts: ["joined"] },
          },
        },
      ],
    });
    await expect(
      repository.claimParentResume(parentRunId, 30_000),
    ).resolves.toBeNull();
    const beforeHeartbeat = await client.query(
      `SELECT run.lease_token, checkpoint.claim_token,
              run.lease_expires_at, checkpoint.claim_expires_at,
              run.lease_expires_at > NOW() AS run_active,
              checkpoint.claim_expires_at > NOW() AS claim_active
       FROM agent_run run
       JOIN agent_run_checkpoint checkpoint ON checkpoint.parent_run_id = run.id
       WHERE run.id = $1`,
      [parentRunId],
    );
    expect(beforeHeartbeat.rows[0]).toMatchObject({
      lease_token: claimed!.token,
      claim_token: claimed!.token,
      run_active: true,
      claim_active: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const heartbeatState = await repository.heartbeat(
      parentRunId,
      claimed!.token,
      60_000,
    );
    const afterHeartbeat = await client.query(
      `SELECT run.lease_expires_at, checkpoint.claim_expires_at,
              run.lease_expires_at = checkpoint.claim_expires_at AS aligned
       FROM agent_run run
       JOIN agent_run_checkpoint checkpoint ON checkpoint.parent_run_id = run.id
       WHERE run.id = $1`,
      [parentRunId],
    );
    expect(heartbeatState, JSON.stringify(afterHeartbeat.rows[0])).toBe(
      "active",
    );
    expect(afterHeartbeat.rows[0].aligned).toBe(true);
    expect(afterHeartbeat.rows[0].lease_expires_at.getTime()).toBeGreaterThan(
      beforeHeartbeat.rows[0].lease_expires_at.getTime(),
    );
    expect(afterHeartbeat.rows[0].claim_expires_at.getTime()).toBeGreaterThan(
      beforeHeartbeat.rows[0].claim_expires_at.getTime(),
    );
    await client.query(
      `UPDATE agent_run SET cancel_requested_at = NOW() WHERE id = $1`,
      [parentRunId],
    );
    await expect(
      repository.finishParentResume(parentRunId, claimed!.token, {
        status: "succeeded",
        result: { assistantMessageId: "assistant-root-1" },
      }),
    ).resolves.toMatchObject({
      status: "cancelled",
      errorCode: "CANCELLED",
      result: null,
    });
    await expect(
      repository.finishParentResume(parentRunId, claimed!.token, {
        status: "succeeded",
        result: {},
      }),
    ).resolves.toBeNull();
  });

  test.each(["cancelled", "timed_out"] as const)(
    "atomically classifies a %s race instead of suspending the parent",
    async (expectedStatus) => {
      const userId = randomUUID();
      const parentRunId = randomUUID();
      const childRunId = randomUUID();
      const childAgentId = randomUUID();
      await client.query(
        `INSERT INTO "user" (id, name, email, password)
         VALUES ($1, 'Suspend Race Owner', $2, 'hash')`,
        [userId, `suspend-race-${userId}@example.test`],
      );
      await client.query(
        `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
        [childAgentId, userId],
      );
      const parent = await repository.createRunning({
        id: parentRunId,
        userId,
        timeoutMs: 600_000,
      });
      await repository.createDelegated({
        id: childRunId,
        delegationId: randomUUID(),
        userId,
        agentId: childAgentId,
        target: { kind: "local", agentId: childAgentId },
        parentRunId,
        objective: "Race suspension",
        context: {},
        allowedTools: [],
        timeoutMs: 60_000,
        depth: 1,
        tokenBudget: 1_000,
        idempotencyKey: `${parentRunId}:race-call`,
        toolCallId: "race-call",
      });
      await client.query(
        expectedStatus === "cancelled"
          ? `UPDATE agent_run SET cancel_requested_at = NOW() WHERE id = $1`
          : `UPDATE agent_run SET absolute_deadline_at = NOW() - interval '1 second'
             WHERE id = $1`,
        [parentRunId],
      );

      await expect(
        repository.suspendParent(parentRunId, parent.leaseToken!, {
          delegationToolCallIds: ["race-call"],
          responseMessages: [],
          modelMessages: [],
          modelConfig: {},
          authorizationRecipe: {},
          assistantMessageId: "assistant-race",
        }),
      ).resolves.toMatchObject({ status: expectedStatus });

      const state = await client.query(
        `SELECT status, lease_token, completed_at FROM agent_run WHERE id = $1`,
        [parentRunId],
      );
      expect(state.rows[0]).toMatchObject({
        status: expectedStatus,
        lease_token: null,
        completed_at: expect.any(Date),
      });
    },
  );

  test("serializes heartbeat against parent resume completion without deadlock", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Resume Lock Owner', $2, 'hash')`,
      [userId, `resume-lock-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run
         (id, user_id, root_run_id, status, absolute_deadline_at)
       VALUES ($1, $2, $1, 'waiting_external', NOW() + interval '10 minutes')`,
      [parentRunId, userId],
    );
    await client.query(
      `INSERT INTO agent_run_checkpoint
         (parent_run_id, response_messages, model_messages, model_config,
          authorization_recipe, assistant_message_id)
       VALUES ($1, '[]', '[]', '{}', '{}', 'assistant-lock-order')`,
      [parentRunId],
    );
    const claimed = await repository.claimParentResume(parentRunId, 30_000);
    expect(claimed).not.toBeNull();
    const gateKey = `${parentRunId}:heartbeat-finish-gate`;
    await installAdvisoryPauseTrigger(
      "agent_run",
      parentRunId,
      "OLD.lease_expires_at IS DISTINCT FROM NEW.lease_expires_at",
      gateKey,
    );
    await client.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
      gateKey,
    ]);
    const heartbeatClient = new Client({ connectionString });
    const finishClient = new Client({ connectionString });
    await Promise.all([heartbeatClient.connect(), finishClient.connect()]);
    await Promise.all([
      heartbeatClient.query(`SET lock_timeout = '5s'`),
      finishClient.query(`SET lock_timeout = '5s'`),
    ]);
    const { createPgAgentRunRepository } = await loadRepositoryModule();
    const heartbeatRepository = createPgAgentRunRepository(
      drizzle(heartbeatClient) as never,
    );
    const finishRepository = createPgAgentRunRepository(
      drizzle(finishClient) as never,
    );

    const heartbeat = heartbeatRepository.heartbeat(
      parentRunId,
      claimed!.token,
      60_000,
    );
    await waitForAdvisoryWait(gateKey);
    const finish = finishRepository.finishParentResume(
      parentRunId,
      claimed!.token,
      { status: "succeeded", result: { exactlyOnce: true } },
    );
    await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
      gateKey,
    ]);
    const [heartbeatState, finished] = await Promise.all([heartbeat, finish]);
    await Promise.all([heartbeatClient.end(), finishClient.end()]);

    expect(heartbeatState).toBe("active");
    expect(finished).toMatchObject({
      status: "succeeded",
      result: { exactlyOnce: true },
    });
    await expect(
      repository.finishParentResume(parentRunId, claimed!.token, {
        status: "failed",
        error: "must not replace completion",
      }),
    ).resolves.toBeNull();
    const state = await client.query(
      `SELECT run.status, run.result, run.lease_token, run.lease_expires_at,
              checkpoint.completed_at, checkpoint.claim_token,
              checkpoint.claim_expires_at
       FROM agent_run run
       JOIN agent_run_checkpoint checkpoint ON checkpoint.parent_run_id = run.id
       WHERE run.id = $1`,
      [parentRunId],
    );
    expect(state.rows[0]).toEqual({
      status: "succeeded",
      result: { exactlyOnce: true },
      lease_token: null,
      lease_expires_at: null,
      completed_at: expect.any(Date),
      claim_token: null,
      claim_expires_at: null,
    });
  });

  test("rejects a resumed checkpoint backed only by an old generation join", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const childAgentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Generation Owner', $2, 'hash')`,
      [userId, `generation-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
      [childAgentId, userId],
    );
    const parent = await repository.createRunning({
      id: parentRunId,
      userId,
      timeoutMs: 600_000,
    });
    await repository.createDelegated({
      id: childRunId,
      delegationId: randomUUID(),
      userId,
      agentId: childAgentId,
      target: { kind: "local", agentId: childAgentId },
      parentRunId,
      objective: "First generation",
      context: {},
      allowedTools: [],
      timeoutMs: 60_000,
      depth: 1,
      tokenBudget: 1_000,
      idempotencyKey: `${parentRunId}:old-call`,
      toolCallId: "old-call",
    });
    const checkpoint = {
      delegationToolCallIds: ["old-call"],
      responseMessages: [],
      modelMessages: [],
      modelConfig: {},
      authorizationRecipe: {},
      assistantMessageId: "assistant-generation",
    };
    await repository.suspendParent(parentRunId, parent.leaseToken!, checkpoint);
    const childLease = await repository.claimQueued(childRunId, 30_000);
    await repository.finishRunning(childRunId, childLease!.token, {
      status: "succeeded",
      result: {},
    });
    const claimed = await repository.claimParentResume(parentRunId, 30_000);

    await expect(
      repository.checkpointParentAgain(parentRunId, claimed!.token, checkpoint),
    ).resolves.toBeNull();
    await expect(repository.selectById(parentRunId)).resolves.toMatchObject({
      status: "running",
      leaseToken: claimed!.token,
    });
    await repository.finishParentResume(parentRunId, claimed!.token, {
      status: "failed",
      error: "Rejected stale join",
      errorCode: "PARENT_SUSPENSION_REJECTED",
    });
  });

  test("classifies a deadline racing parent resume completion as timed out", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Deadline Owner', $2, 'hash')`,
      [userId, `deadline-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run
         (id, user_id, root_run_id, status, absolute_deadline_at)
       VALUES ($1, $2, $1, 'waiting_external', NOW() + interval '10 minutes')`,
      [parentRunId, userId],
    );
    await client.query(
      `INSERT INTO agent_run_checkpoint
         (parent_run_id, response_messages, model_messages, model_config,
          authorization_recipe, assistant_message_id)
       VALUES ($1, '[]', '[]', '{}', '{}', 'assistant-deadline')`,
      [parentRunId],
    );
    const claimed = await repository.claimParentResume(parentRunId, 30_000);
    expect(claimed).not.toBeNull();
    await client.query(
      `UPDATE agent_run SET absolute_deadline_at = NOW() - interval '1 second'
       WHERE id = $1`,
      [parentRunId],
    );

    await expect(
      repository.finishParentResume(parentRunId, claimed!.token, {
        status: "succeeded",
        result: { assistantMessageId: "assistant-deadline" },
      }),
    ).resolves.toMatchObject({
      status: "timed_out",
      errorCode: "TIMED_OUT",
      result: null,
    });
  });

  test("rearms deferred dispatch and retains credentials through remote cancellation", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const remoteAgentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Run Owner', $2, 'hash')`,
      [userId, `run-repository-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO remote_agent (id, user_id, name, endpoint_url)
       VALUES ($1, $2, 'Remote', 'https://remote.example.test/a2a')`,
      [remoteAgentId, userId],
    );
    await client.query(
      `INSERT INTO agent_run (id, user_id, root_run_id, status, absolute_deadline_at)
       VALUES ($1, $2, $1, 'queued', NOW() + interval '10 minutes')`,
      [parentRunId, userId],
    );
    await client.query(
      `INSERT INTO root_run_budget
         (root_run_id, max_steps, max_tokens, max_duration_ms, max_tool_calls,
          max_delegations, max_delegation_depth, max_parallel_children,
          max_sandbox_compute_ms)
       VALUES ($1, 10, 50000, 600000, 32, 8, 3, 8, 300000)`,
      [parentRunId],
    );
    await repository.createDelegated({
      id: childRunId,
      delegationId: randomUUID(),
      userId,
      target: { kind: "remote", connectionId: remoteAgentId },
      parentRunId,
      objective: "Verify durable external work",
      context: {},
      allowedTools: [],
      timeoutMs: 600_000,
      depth: 1,
      tokenBudget: 5_000,
      idempotencyKey: "durable-external-1",
      toolCallId: "delegate-call-1",
    });
    await repository.markDispatched(childRunId);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 30_000);
    const absoluteDeadlineAt = new Date(Date.now() + 600_000);
    await client.query(
      `UPDATE agent_run
       SET status = 'running', lease_token = $2,
           lease_expires_at = $3, absolute_deadline_at = $4,
           started_at = $5, attempt = attempt + 1
       WHERE id = $1`,
      [childRunId, leaseToken, leaseExpiresAt, absoluteDeadlineAt, new Date()],
    );
    await client.query(
      `UPDATE delegation_run SET status = 'running' WHERE child_run_id = $1`,
      [childRunId],
    );
    await client.query(
      `INSERT INTO agent_run_continuation
        (run_id, kind, submission_id, message_id, encrypted_credential,
         consumed_at)
       VALUES ($1, 'credential', gen_random_uuid(), gen_random_uuid(),
               'encrypted-transient-credential', NOW())`,
      [childRunId],
    );
    const availableAt = new Date(Date.now() + 15_000);

    await expect(
      repository.deferRemoteTask(
        childRunId,
        leaseToken,
        "REMOTE_WORKING",
        { id: "remote-task-1", state: "working" },
        availableAt,
      ),
    ).resolves.toMatchObject({ status: "waiting_external" });

    const dispatch = await client.query(
      `SELECT available_at <> created_at AS available_changed, dispatched_at
       FROM agent_run_dispatch
       WHERE run_id = $1`,
      [childRunId],
    );
    expect(dispatch.rows[0].dispatched_at).toBeNull();
    expect(dispatch.rows[0].available_changed).toBe(true);
    expect(
      await repository.requestCancellationTree(childRunId, userId),
    ).toMatchObject({
      status: "waiting_external",
      cancelRequestedAt: expect.any(Date),
    });
    await expect(
      repository.prepareRemoteCancellation(childRunId),
    ).resolves.toMatchObject({
      remoteAgentId,
      remoteTaskId: "remote-task-1",
      encryptedCredential: "encrypted-transient-credential",
    });

    const cancelled = await repository.recordRemoteCancellation(childRunId, {
      ok: true,
      task: { id: "remote-task-1", state: "cancelled" },
    });

    expect(cancelled).toMatchObject({
      status: "cancelled",
      errorCode: "CANCELLED",
    });
    const credential = await client.query(
      `SELECT encrypted_credential FROM agent_run_continuation
       WHERE run_id = $1 AND kind = 'credential'`,
      [childRunId],
    );
    expect(credential.rowCount).toBe(0);
    const outcome = await client.query(
      `SELECT remote_outcome, completed_at FROM agent_run_remote_cancel
       WHERE run_id = $1`,
      [childRunId],
    );
    expect(outcome.rows[0]).toMatchObject({
      remote_outcome: { id: "remote-task-1", state: "cancelled" },
      completed_at: expect.any(Date),
    });
  });

  test("releases nested queued and waiting child capacity on tree cancellation", async () => {
    const userId = randomUUID();
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const grandchildRunId = randomUUID();
    const agentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Cancellation Budget Owner', $2, 'hash')`,
      [userId, `cancel-budget-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
      [agentId, userId],
    );
    await repository.createRunning({
      id: rootRunId,
      userId,
      timeoutMs: 600_000,
      budget: { maxParallel: 2 },
    });
    const delegate = async (runId: string, parentRunId: string, call: string) =>
      repository.createDelegated({
        id: runId,
        delegationId: randomUUID(),
        userId,
        agentId,
        target: { kind: "local", agentId },
        parentRunId,
        objective: call,
        context: {},
        allowedTools: [],
        timeoutMs: 60_000,
        depth: parentRunId === rootRunId ? 1 : 2,
        tokenBudget: 1_000,
        idempotencyKey: `${parentRunId}:${call}`,
        toolCallId: call,
      });
    await delegate(childRunId, rootRunId, "child");
    await delegate(grandchildRunId, childRunId, "grandchild");
    await client.query(
      `UPDATE agent_run SET status = 'waiting_input' WHERE id = $1`,
      [childRunId],
    );
    await client.query(
      `UPDATE delegation_run SET status = 'waiting_input'
       WHERE child_run_id = $1`,
      [childRunId],
    );

    await expect(
      repository.requestCancellationTree(childRunId, userId),
    ).resolves.toMatchObject({ status: "cancelled" });
    await expect(
      repository.requestCancellationTree(childRunId, userId),
    ).resolves.toBeNull();

    const budget = await client.query(
      `SELECT reserved_children, committed_children
       FROM root_run_budget WHERE root_run_id = $1`,
      [rootRunId],
    );
    expect(budget.rows[0]).toEqual({
      reserved_children: 0,
      committed_children: 0,
    });
    const reservations = await client.query(
      `SELECT state, committed_amount FROM root_run_budget_reservation
       WHERE token IN ($1, $2) ORDER BY token`,
      [`child:${childRunId}`, `child:${grandchildRunId}`],
    );
    expect(reservations.rows).toEqual([
      { state: "released", committed_amount: null },
      { state: "released", committed_amount: null },
    ]);

    await expect(
      delegate(randomUUID(), rootRunId, "replacement-a"),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      delegate(randomUUID(), rootRunId, "replacement-b"),
    ).resolves.toMatchObject({ status: "queued" });
  });

  test("reconstructs a missing budget-exhausted join and cleans credentials", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    const childRunId = randomUUID();
    const agentId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Recovery Owner', $2, 'hash')`,
      [userId, `recovery-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
      [agentId, userId],
    );
    await repository.createRunning({ id: parentRunId, userId });
    await repository.createDelegated({
      id: childRunId,
      delegationId: randomUUID(),
      userId,
      agentId,
      target: { kind: "local", agentId },
      parentRunId,
      objective: "Recover terminal side effects",
      context: {},
      allowedTools: [],
      timeoutMs: 60_000,
      depth: 1,
      tokenBudget: 1_000,
      idempotencyKey: `${parentRunId}:recover`,
      toolCallId: "recover",
    });
    await client.query(
      `UPDATE agent_run
       SET status = 'budget_exhausted', completed_at = NOW(),
           error = 'Budget exhausted', error_code = 'BUDGET_EXHAUSTED'
       WHERE id = $1`,
      [childRunId],
    );
    await client.query(
      `UPDATE delegation_run
       SET status = 'budget_exhausted', completed_at = NOW(),
           error = 'Budget exhausted', error_code = 'BUDGET_EXHAUSTED'
       WHERE child_run_id = $1`,
      [childRunId],
    );
    await client.query(
      `INSERT INTO agent_run_continuation
         (run_id, kind, submission_id, message_id, encrypted_credential)
       VALUES ($1, 'credential', gen_random_uuid(), gen_random_uuid(), 'secret')`,
      [childRunId],
    );

    const rediscovered = await repository.reconcileTerminalDelegatedRuns(100);
    expect(rediscovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: childRunId, status: "budget_exhausted" }),
      ]),
    );
    const repaired = await client.query(
      `SELECT join_row.observation, join_row.completed_at,
              reservation.state, budget.reserved_children,
              budget.committed_children,
              EXISTS (SELECT 1 FROM agent_run_continuation continuation
                      WHERE continuation.run_id = $1
                        AND continuation.kind = 'credential') AS has_credential
       FROM agent_run_join join_row
       JOIN root_run_budget_reservation reservation
         ON reservation.token = 'child:' || ($1::uuid)::text
       JOIN root_run_budget budget ON budget.root_run_id = reservation.root_run_id
       WHERE join_row.child_run_id = $1::uuid`,
      [childRunId],
    );
    expect(repaired.rows[0]).toMatchObject({
      observation: {
        childRunId,
        status: "budget_exhausted",
        errorCode: "BUDGET_EXHAUSTED",
      },
      completed_at: expect.any(Date),
      state: "committed",
      reserved_children: 0,
      committed_children: 1,
      has_credential: false,
    });

    await client.query(
      `INSERT INTO iris_activity_event
         (user_id, actor_type, event_type, subject_type, subject_id, run_id,
          idempotency_key)
       VALUES ($1, 'agent', 'delegation.failed', 'agent_run', $2, $2, $3)`,
      [userId, childRunId, `delegation-terminal:${childRunId}`],
    );
    expect(
      (await repository.reconcileTerminalDelegatedRuns(100)).some(
        (run) => run.id === childRunId,
      ),
    ).toBe(false);
  });

  test.each(["waiting_input", "waiting_approval"] as const)(
    "times out an expired %s child without a user response and resumes its parent once",
    async (waitingStatus) => {
      const userId = randomUUID();
      const parentRunId = randomUUID();
      const childRunId = randomUUID();
      const agentId = randomUUID();
      await client.query(
        `INSERT INTO "user" (id, name, email, password)
         VALUES ($1, 'Waiting Deadline Owner', $2, 'hash')`,
        [userId, `waiting-deadline-${randomUUID()}@example.test`],
      );
      await client.query(
        `INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Child')`,
        [agentId, userId],
      );
      const parent = await repository.createRunning({
        id: parentRunId,
        userId,
        timeoutMs: 600_000,
      });
      await repository.createDelegated({
        id: childRunId,
        delegationId: randomUUID(),
        userId,
        agentId,
        target: { kind: "local", agentId },
        parentRunId,
        objective: "Wait for a user who never responds",
        context: {},
        allowedTools: [],
        timeoutMs: 60_000,
        depth: 1,
        tokenBudget: 1_000,
        idempotencyKey: `${parentRunId}:${waitingStatus}`,
        toolCallId: waitingStatus,
      });
      await repository.suspendParent(parentRunId, parent.leaseToken!, {
        delegationToolCallIds: [waitingStatus],
        responseMessages: [],
        modelMessages: [],
        modelConfig: {},
        authorizationRecipe: {},
        assistantMessageId: `assistant-${waitingStatus}`,
      });
      await client.query(
        `UPDATE agent_run
         SET status = $2, absolute_deadline_at = NOW() - interval '1 second'
         WHERE id = $1`,
        [childRunId, waitingStatus],
      );
      await client.query(
        `UPDATE delegation_run SET status = $2 WHERE child_run_id = $1`,
        [childRunId, waitingStatus],
      );
      await client.query(
        `INSERT INTO agent_run_continuation
           (run_id, kind, submission_id, message_id, encrypted_credential)
         VALUES ($1, 'credential', gen_random_uuid(), gen_random_uuid(), 'secret')`,
        [childRunId],
      );

      const [first, second] = await Promise.all([
        repository.reconcileTerminalDelegatedRuns(100),
        repository.reconcileTerminalDelegatedRuns(100),
      ]);
      expect([...first, ...second]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: childRunId,
            status: "timed_out",
            errorCode: "TIMED_OUT",
          }),
        ]),
      );
      const state = await client.query(
        `SELECT run.status, run.error_code, delegation.status AS delegation_status,
                join_row.observation, reservation.state AS reservation_state,
                budget.reserved_children, budget.committed_children,
                dispatch.dispatched_at,
                EXISTS (SELECT 1 FROM agent_run_continuation continuation
                        WHERE continuation.run_id = $1
                          AND continuation.kind = 'credential') AS has_credential
         FROM agent_run run
         JOIN delegation_run delegation ON delegation.child_run_id = run.id
         JOIN agent_run_join join_row ON join_row.child_run_id = run.id
         JOIN root_run_budget_reservation reservation
           ON reservation.token = 'child:' || run.id::text
         JOIN root_run_budget budget ON budget.root_run_id = run.root_run_id
         LEFT JOIN agent_run_resume_dispatch dispatch
           ON dispatch.parent_run_id = run.parent_run_id
         WHERE run.id = $1`,
        [childRunId],
      );
      expect(state.rows[0]).toMatchObject({
        status: "timed_out",
        error_code: "TIMED_OUT",
        delegation_status: "timed_out",
        observation: { status: "timed_out", errorCode: "TIMED_OUT" },
        reservation_state: "committed",
        reserved_children: 0,
        committed_children: 1,
        dispatched_at: null,
        has_credential: false,
      });
      expect(
        await repository.claimParentResume(parentRunId, 30_000),
      ).toMatchObject({
        run: { status: "running" },
        joins: [
          {
            childRunId,
            observation: { status: "timed_out", errorCode: "TIMED_OUT" },
          },
        ],
      });
      expect(
        await repository.claimParentResume(parentRunId, 30_000),
      ).toBeNull();
      await expect(
        repository.reconcileTerminalDelegatedRuns(100),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: childRunId, status: "timed_out" }),
        ]),
      );
      await client.query(
        `INSERT INTO iris_activity_event
           (user_id, actor_type, event_type, subject_type, subject_id, run_id,
            idempotency_key)
         VALUES ($1, 'agent', 'delegation.timed_out', 'agent_run', $2, $2, $3)`,
        [userId, childRunId, `delegation-terminal:${childRunId}`],
      );
      expect(
        (await repository.reconcileTerminalDelegatedRuns(100)).some(
          (run) => run.id === childRunId,
        ),
      ).toBe(false);
    },
  );

  test("expires a waiting parent without relying on resume dispatch", async () => {
    const userId = randomUUID();
    const parentRunId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Expired Parent Owner', $2, 'hash')`,
      [userId, `expired-parent-${userId}@example.test`],
    );
    await client.query(
      `INSERT INTO agent_run
         (id, user_id, root_run_id, status, absolute_deadline_at)
       VALUES ($1, $2, $1, 'waiting_external', NOW() - interval '1 second')`,
      [parentRunId, userId],
    );
    await client.query(
      `INSERT INTO root_run_budget
         (root_run_id, max_steps, max_tokens, max_duration_ms, max_tool_calls,
          max_delegations, max_delegation_depth, max_parallel_children,
          max_sandbox_compute_ms)
       VALUES ($1, 10, 50000, 600000, 32, 8, 3, 8, 300000)`,
      [parentRunId],
    );
    await client.query(
      `INSERT INTO agent_run_checkpoint
         (parent_run_id, response_messages, model_messages, model_config,
          authorization_recipe, assistant_message_id)
       VALUES ($1, '[]', '[]', '{}', '{}', 'assistant-expired-parent')`,
      [parentRunId],
    );

    await Promise.all([
      repository.reconcileTerminalDelegatedRuns(100),
      repository.reconcileTerminalDelegatedRuns(100),
    ]);

    const state = await client.query(
      `SELECT run.status, run.error_code, checkpoint.completed_at,
              EXISTS (SELECT 1 FROM agent_run_resume_dispatch dispatch
                      WHERE dispatch.parent_run_id = run.id) AS has_dispatch
       FROM agent_run run
       JOIN agent_run_checkpoint checkpoint ON checkpoint.parent_run_id = run.id
       WHERE run.id = $1`,
      [parentRunId],
    );
    expect(state.rows[0]).toMatchObject({
      status: "timed_out",
      error_code: "TIMED_OUT",
      completed_at: expect.any(Date),
      has_dispatch: false,
    });
  });

  test("projects PostgreSQL run rows with canonical summary semantics", async () => {
    const userId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, password)
       VALUES ($1, 'Summary Owner', $2, 'hash')`,
      [userId, `summary-${userId}@example.test`],
    );
    const statuses = [
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "budget_exhausted",
    ] as const;
    for (const status of statuses) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO agent_run
           (id, user_id, root_run_id, status, completed_at,
            lease_token, lease_expires_at)
         VALUES ($1, $2, $1, $3::varchar,
                 CASE WHEN $3::varchar = 'running' THEN NULL ELSE NOW() END,
                 CASE WHEN $3::varchar = 'running' THEN gen_random_uuid() ELSE NULL END,
                 CASE WHEN $3::varchar = 'running' THEN NOW() + interval '1 minute' ELSE NULL END)`,
        [id, userId, status],
      );
    }
    const rows = await client.query(
      `SELECT * FROM agent_run WHERE user_id = $1`,
      [userId],
    );
    const { summarizeAgentRunStatuses } = await import("lib/ai/runs/status");

    expect(
      summarizeAgentRunStatuses(
        rows.rows.map((row) => ({
          status: row.status,
          cancelRequestedAt: row.cancel_requested_at,
        })),
      ),
    ).toEqual({
      active: 1,
      failed: 3,
      retryable: 2,
      cancellable: 1,
    });
  });
});

async function installAgentRunPauseTrigger(runId: string, condition: string) {
  const suffix = runId.replaceAll("-", "_");
  await client.query(`
    CREATE OR REPLACE FUNCTION pause_agent_run_${suffix}()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_sleep(0.5);
      RETURN NEW;
    END $$;
    CREATE TRIGGER pause_agent_run_${suffix}
    BEFORE UPDATE ON agent_run
    FOR EACH ROW
    WHEN (OLD.id = '${runId}'::uuid AND ${condition})
    EXECUTE FUNCTION pause_agent_run_${suffix}();
  `);
}

async function installAdvisoryPauseTrigger(
  table: string,
  rowId: string,
  condition: string,
  gateKey: string,
) {
  const suffix = rowId.replaceAll("-", "_");
  await client.query(`
    CREATE OR REPLACE FUNCTION advisory_pause_${suffix}()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('${gateKey}', 0));
      RETURN NEW;
    END $$;
    CREATE TRIGGER advisory_pause_${suffix}
    BEFORE UPDATE ON ${table}
    FOR EACH ROW
    WHEN (OLD.id = '${rowId}'::uuid AND ${condition})
    EXECUTE FUNCTION advisory_pause_${suffix}();
  `);
}

async function waitForAdvisoryWait(gateKey: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await client.query(
      `SELECT 1
       FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted
         AND classid::bigint =
             ((hashtextextended($1, 0) >> 32) & 4294967295)
         AND objid::bigint =
             (hashtextextended($1, 0) & 4294967295)`,
      [gateKey],
    );
    if (waiting.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("TEST_ADVISORY_WAIT_NOT_OBSERVED");
}
