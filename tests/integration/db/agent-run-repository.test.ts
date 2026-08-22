import { randomUUID } from "node:crypto";
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
});
