import { randomUUID } from "node:crypto";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { applyMigrations, recreatePublicSchema } from "./migration-harness";

const connectionString = process.env.TEST_POSTGRES_URL;
if (!connectionString) throw new Error("TEST_POSTGRES_URL is required");

const client = new Client({ connectionString });
vi.mock("server-only", () => ({}));
type BudgetAuthorityModule = Awaited<
  ReturnType<typeof loadBudgetAuthorityModule>
>;
const loadBudgetAuthorityModule = () =>
  import("lib/ai/runtime/server-budget-authority");
let authority: BudgetAuthorityModule["serverBudgetAuthority"];
let resolveBudget: typeof import("lib/ai/runtime/server-budget-resolver").serverBudgetResolver;

beforeAll(async () => {
  await client.connect();
  process.env.POSTGRES_URL = connectionString;
  authority = (await import("lib/ai/runtime/server-budget-authority"))
    .serverBudgetAuthority;
  resolveBudget = (await import("lib/ai/runtime/server-budget-resolver"))
    .serverBudgetResolver;
});
beforeEach(async () => {
  await recreatePublicSchema(client);
  await applyMigrations(client);
});
afterAll(async () => {
  await recreatePublicSchema(client);
  await client.end();
});

async function root(maxTokens = 10, maxParallelChildren = 1) {
  const userId = randomUUID();
  const rootRunId = randomUUID();
  await client.query(
    `INSERT INTO "user" (id, name, email, password)
     VALUES ($1, 'Budget Owner', $2, 'hash')`,
    [userId, `budget-${userId}@example.test`],
  );
  await client.query(
    `INSERT INTO agent_run
       (id, user_id, root_run_id, status, lease_token, lease_expires_at,
        absolute_deadline_at, attempt)
     VALUES ($1, $2, $1, 'running', gen_random_uuid(),
             NOW() + interval '30 seconds', NOW() + interval '5 minutes', 1)`,
    [rootRunId, userId],
  );
  await client.query(
    `INSERT INTO root_run_budget
       (root_run_id, max_steps, max_tokens, max_duration_ms, max_tool_calls,
        max_delegations, max_delegation_depth, max_parallel_children,
        max_sandbox_compute_ms)
     VALUES ($1, 10, $2, 90000, 10, 8, 3, $3, 1000)`,
    [rootRunId, maxTokens, maxParallelChildren],
  );
  return { userId, rootRunId };
}

describe("durable root budget authority", () => {
  test("serializes sibling allocations and keeps nested runs on one root", async () => {
    const { userId, rootRunId } = await root(10, 1);
    const childId = randomUUID();
    await client.query(
      `INSERT INTO agent_run (id, user_id, parent_run_id, root_run_id, status)
       VALUES ($1, $2, $3, $3, 'queued')`,
      [childId, userId, rootRunId],
    );
    const expiresAt = new Date(Date.now() + 60_000);
    const results = await Promise.allSettled([
      authority.reserve({
        runId: rootRunId,
        token: "sibling-a",
        kind: "children",
        amount: 1,
        expiresAt,
      }),
      authority.reserve({
        runId: childId,
        token: "sibling-b",
        kind: "children",
        amount: 1,
        expiresAt,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
  });

  test("persists usage across restart-like calls and settlement is idempotent", async () => {
    const { rootRunId } = await root();
    await authority.charge(rootRunId, "tokens:step-1", "tokens", 7);
    await authority.charge(rootRunId, "tokens:step-1", "tokens", 7);
    await expect(
      authority.charge(rootRunId, "tokens:step-2", "tokens", 4),
    ).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });

    await authority.reserve({
      runId: rootRunId,
      token: "compute-1",
      kind: "sandbox_compute_ms",
      amount: 100,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await authority.settle("compute-1", 60)).toBe(true);
    expect(await authority.settle("compute-1", 60)).toBe(false);
    const usage = await client.query(
      `SELECT committed_tokens, committed_sandbox_compute_ms,
              reserved_sandbox_compute_ms
       FROM root_run_budget WHERE root_run_id = $1`,
      [rootRunId],
    );
    expect(usage.rows[0]).toEqual({
      committed_tokens: 7,
      committed_sandbox_compute_ms: 60,
      reserved_sandbox_compute_ms: 0,
    });
  });

  test("releases cancellation reservations and fails closed on corruption", async () => {
    const { rootRunId } = await root();
    await authority.reserve({
      runId: rootRunId,
      token: "cancelled-child",
      kind: "children",
      amount: 1,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await authority.settle("cancelled-child", null)).toBe(true);
    expect(await authority.settle("cancelled-child", null)).toBe(false);
    await client.query(`DELETE FROM root_run_budget WHERE root_run_id = $1`, [
      rootRunId,
    ]);
    await expect(
      authority.charge(rootRunId, "tool:1", "tool_calls", 1),
    ).rejects.toThrow("ROOT_RUN_BUDGET_NOT_FOUND");
  });

  test("loads immutable root limits and treats restore as narrowing only", async () => {
    const { userId, rootRunId } = await root(10);
    await expect(
      resolveBudget({
        runId: rootRunId,
        userId,
        surface: "resume",
        requestedBudget: { maxTokens: 20 },
        restore: { budget: { maxTokens: 5, maxDurationMs: 300_000 } },
      }),
    ).resolves.toMatchObject({ maxTokens: 5, maxDurationMs: 90_000 });

    await client.query(`DELETE FROM root_run_budget WHERE root_run_id = $1`, [
      rootRunId,
    ]);
    await expect(
      resolveBudget({ runId: rootRunId, userId, surface: "resume" }),
    ).rejects.toThrow("ROOT_RUN_BUDGET_NOT_FOUND");
  });

  test("reaps only expired reservations whose work is terminal", async () => {
    const { rootRunId } = await root(10);
    const expired = new Date(Date.now() - 1_000);
    await authority.reserve({
      runId: rootRunId,
      token: "expired-tokens",
      kind: "tokens",
      amount: 3,
      expiresAt: expired,
    });
    await authority.reserve({
      runId: rootRunId,
      token: "expired-sandbox",
      kind: "sandbox_compute_ms",
      amount: 100,
      expiresAt: expired,
    });

    expect(await authority.reconcileExpiredReservations()).toBe(0);
    await client.query(
      `UPDATE agent_run
       SET status = 'cancelled', completed_at = NOW(),
           lease_token = NULL, lease_expires_at = NULL
       WHERE id = $1`,
      [rootRunId],
    );
    expect(await authority.reconcileExpiredReservations()).toBe(1);
    expect(await authority.reconcileExpiredReservations()).toBe(0);

    const state = await client.query(
      `SELECT reserved_tokens, reserved_sandbox_compute_ms
       FROM root_run_budget WHERE root_run_id = $1`,
      [rootRunId],
    );
    expect(state.rows[0]).toEqual({
      reserved_tokens: 0,
      reserved_sandbox_compute_ms: 100,
    });
  });
});
