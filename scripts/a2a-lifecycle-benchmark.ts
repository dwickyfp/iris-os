import "server-only";

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import PgBoss from "pg-boss";
import {
  A2A_BENCHMARK_GUARD_TABLE,
  type DisposableBenchmarkProof,
  assertDisposableBenchmarkProof,
} from "./a2a-disposable-benchmark-safety";

type Timing = { count: number; minMs: number; maxMs: number; meanMs: number };

export async function confirmDisposableBenchmarkTarget(
  client: Client,
  proof: DisposableBenchmarkProof,
): Promise<void> {
  assertDisposableBenchmarkProof(proof);
  const result = await client.query<{
    current_database: string;
    database_name: string;
    disposable_marker: string;
    disposable_token: string;
    wrapper_nonce: string;
  }>(
    `SELECT current_database(), database_name, disposable_marker,
            disposable_token, wrapper_nonce
       FROM ${A2A_BENCHMARK_GUARD_TABLE}`,
  );
  const guard = result.rows[0];
  if (
    result.rowCount !== 1 ||
    guard?.current_database !== proof.database ||
    guard.database_name !== proof.database ||
    guard.disposable_marker !== proof.marker ||
    guard.disposable_token !== proof.token ||
    guard.wrapper_nonce !== proof.nonce
  ) {
    throw new Error("A2A benchmark disposable database confirmation failed");
  }
}

function timing(values: number[]): Timing {
  return {
    count: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

async function main() {
  const connectionString = process.env.A2A_BENCHMARK_POSTGRES_URL;
  if (!connectionString) {
    throw new Error("A2A_BENCHMARK_POSTGRES_URL is required");
  }
  const proof: DisposableBenchmarkProof = {
    connectionString,
    database: process.env.A2A_BENCHMARK_DATABASE ?? "",
    marker: process.env.A2A_BENCHMARK_DISPOSABLE_MARKER ?? "",
    token: process.env.A2A_BENCHMARK_DISPOSABLE_TOKEN ?? "",
    nonce: process.env.A2A_BENCHMARK_WRAPPER_NONCE ?? "",
    applicationDatabaseUrls: [
      process.env.POSTGRES_URL,
      process.env.DATABASE_URL,
      process.env.TEST_POSTGRES_URL,
    ],
  };
  const iterations = Number(process.env.A2A_BENCHMARK_ITERATIONS ?? 25);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000) {
    throw new Error(
      "A2A_BENCHMARK_ITERATIONS must be an integer from 1 to 10000",
    );
  }

  const client = new Client({ connectionString });
  const boss = new PgBoss({ connectionString });
  const queue = `a2a-lifecycle-benchmark-${randomUUID()}`;
  const prefix = `a2a-benchmark-${randomUUID()}`;
  const queueLatencies: number[] = [];
  const leaseLatencies: number[] = [];
  const rejoinLatencies: number[] = [];
  const violations: string[] = [];
  assertDisposableBenchmarkProof(proof);
  await client.connect();
  try {
    await confirmDisposableBenchmarkTarget(client, proof);
    process.env.POSTGRES_URL = connectionString;
    await boss.start();
    const tables = await client.query<{ agent_run: string | null }>(
      "SELECT to_regclass('public.agent_run')::text AS agent_run",
    );
    if (!tables.rows[0]?.agent_run) {
      throw new Error("Disposable target must have current IRIS migrations");
    }
    await boss.createQueue(queue);
    const completions = new Map<string, () => void>();
    await boss.work(queue, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const data = job.data as { id?: unknown };
        completions.get(String(data.id))?.();
      }
    });

    const { pgAgentRunRepository: repository } = await import(
      "lib/db/pg/repositories/agent-run-repository.pg"
    );
    for (let index = 0; index < iterations; index += 1) {
      const userId = randomUUID();
      const queueId = `${prefix}-queue-${index}`;
      try {
        const queuedAt = performance.now();
        const complete = new Promise<void>((resolve) =>
          completions.set(queueId, resolve),
        );
        await boss.send(queue, { id: queueId });
        await complete;
        queueLatencies.push(performance.now() - queuedAt);

        const parentRunId = randomUUID();
        const childRunId = randomUUID();
        const agentId = randomUUID();
        await client.query(
          `INSERT INTO "user" (id, name, email, password)
           VALUES ($1, 'A2A Benchmark', $2, 'unusable')`,
          [userId, `${prefix}-${index}@example.test`],
        );
        await client.query(
          "INSERT INTO agent (id, user_id, name) VALUES ($1, $2, 'Benchmark Child')",
          [agentId, userId],
        );
        const parent = await repository.createRunning({
          id: parentRunId,
          userId,
          timeoutMs: 60_000,
        });
        await repository.createDelegated({
          id: childRunId,
          delegationId: randomUUID(),
          userId,
          agentId,
          target: { kind: "local", agentId },
          parentRunId,
          objective: "Benchmark lease and parent rejoin",
          context: {},
          allowedTools: [],
          timeoutMs: 60_000,
          depth: 1,
          tokenBudget: 1_000,
          idempotencyKey: `${prefix}-${index}`,
          toolCallId: `call-${index}`,
        });

        const leaseStarted = performance.now();
        const firstLease = await repository.claimQueued(childRunId, 1);
        await new Promise((resolve) => setTimeout(resolve, 3));
        const reclaimed = await repository.claimQueued(childRunId, 30_000);
        leaseLatencies.push(performance.now() - leaseStarted);
        if (!firstLease || !reclaimed || firstLease.token === reclaimed.token) {
          violations.push(`lease-reclaim-${index}`);
          continue;
        }
        if (
          await repository.finishRunning(childRunId, firstLease.token, {
            status: "succeeded",
            result: { stale: true },
          })
        ) {
          violations.push(`stale-lease-fence-${index}`);
        }

        const rejoinStarted = performance.now();
        const suspended = await repository.suspendParent(
          parentRunId,
          parent.leaseToken!,
          {
            delegationToolCallIds: [`call-${index}`],
            responseMessages: [],
            modelMessages: [],
            modelConfig: {},
            authorizationRecipe: {},
            assistantMessageId: `assistant-${index}`,
          },
        );
        await repository.finishRunning(childRunId, reclaimed.token, {
          status: "succeeded",
          result: { index },
        });
        const resumed = await repository.claimParentResume(parentRunId, 30_000);
        const duplicate = await repository.claimParentResume(
          parentRunId,
          30_000,
        );
        rejoinLatencies.push(performance.now() - rejoinStarted);
        if (
          suspended?.status !== "waiting_external" ||
          !resumed ||
          resumed.joins.length !== 1 ||
          duplicate !== null
        ) {
          violations.push(`parent-rejoin-${index}`);
        } else {
          await repository.finishParentResume(parentRunId, resumed.token, {
            status: "succeeded",
            result: { benchmark: true },
          });
        }
      } finally {
        completions.delete(queueId);
        await client.query('DELETE FROM "user" WHERE id = $1', [userId]);
      }
    }
  } finally {
    try {
      await boss.stop({ graceful: true, timeout: 5_000 });
    } finally {
      await client.end();
    }
  }

  const report = {
    schemaVersion: 1,
    benchmark: "a2a-db-pgboss-lease-parent-rejoin",
    iterations,
    passed: violations.length === 0,
    invariants: {
      pgbossDelivery: queueLatencies.length === iterations,
      leaseReclaimed: !violations.some((value) =>
        value.startsWith("lease-reclaim"),
      ),
      staleLeaseFenced: !violations.some((value) =>
        value.startsWith("stale-lease"),
      ),
      parentRejoinedOnce: !violations.some((value) =>
        value.startsWith("parent-rejoin"),
      ),
    },
    timings: {
      pgbossDelivery: timing(queueLatencies),
      leaseReclaim: timing(leaseLatencies),
      parentRejoin: timing(rejoinLatencies),
    },
    violations,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.passed ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
