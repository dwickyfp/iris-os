import "server-only";

import { sql } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import type {
  CreateDurableJobInput,
  DurableJob,
  DurableJobHeartbeatResult,
  DurableJobLease,
  DurableJobMutationResult,
  DurableJobRepository,
  RunInboxCompletion,
  TerminalDurableJob,
} from "./contracts";
import { assertAllowedDurableJobTarget } from "./targets";

type QueryResult = { rows: Record<string, unknown>[] };

export interface DurableJobQueryExecutor {
  execute(query: ReturnType<typeof sql>): Promise<QueryResult>;
  transaction<T>(
    operation: (tx: DurableJobQueryExecutor) => Promise<T>,
  ): Promise<T>;
}

export type DurableJobRetryResult =
  | { kind: "retry_scheduled"; job: DurableJob }
  | { kind: "exhausted"; job: TerminalDurableJob }
  | { kind: "not_found" | "lease_lost" };

export type DurableJobOutboxLease = {
  id: string;
  completion: RunInboxCompletion;
  leaseToken: string;
};

export interface DurableJobPgRepository extends DurableJobRepository {
  failExpiredMaxAttempts(): Promise<number>;
  retry(input: {
    jobId: string;
    leaseToken: string;
    error: string;
    errorCode?: string;
    delayMs: number;
  }): Promise<DurableJobRetryResult>;
  claimCompletionOutbox(input: {
    leaseDurationMs: number;
  }): Promise<DurableJobOutboxLease | null>;
  completeCompletionOutbox(input: {
    id: string;
    leaseToken: string;
  }): Promise<boolean>;
  retryCompletionOutbox(input: {
    id: string;
    leaseToken: string;
    error: string;
    delayMs: number;
  }): Promise<boolean>;
}

type JobRow = {
  id: string;
  idempotencyKey: string;
  target: DurableJob["target"];
  payload: unknown;
  status: DurableJob["status"];
  runId: string | null;
  correlationId: string | null;
  attempt: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | string | null;
  outcome: DurableJob["outcome"] | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

const jobProjection = sql.raw(`
  id,
  idempotency_key AS "idempotencyKey",
  target,
  payload,
  status,
  run_id AS "runId",
  correlation_id AS "correlationId",
  attempt,
  lease_token AS "leaseToken",
  lease_expires_at AS "leaseExpiresAt",
  outcome,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`);

const claimedJobProjection = sql.raw(`
  j.id,
  j.idempotency_key AS "idempotencyKey",
  j.target,
  j.payload,
  j.status,
  j.run_id AS "runId",
  j.correlation_id AS "correlationId",
  j.attempt,
  j.lease_token AS "leaseToken",
  j.lease_expires_at AS "leaseExpiresAt",
  j.outcome,
  j.created_at AS "createdAt",
  j.updated_at AS "updatedAt"
`);

function date(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function mapJob(value: Record<string, unknown>): DurableJob {
  const row = value as unknown as JobRow;
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    target: row.target,
    payload: row.payload,
    status: row.status,
    ...(row.runId && row.correlationId
      ? { runInbox: { runId: row.runId, correlationId: row.correlationId } }
      : {}),
    attempt: row.attempt,
    ...(row.leaseToken ? { leaseToken: row.leaseToken } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: date(row.leaseExpiresAt) } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
  };
}

function terminal(job: DurableJob) {
  return job as TerminalDurableJob;
}

async function selectJob(executor: DurableJobQueryExecutor, jobId: string) {
  const result = await executor.execute(sql`
    SELECT ${jobProjection}
    FROM durable_job
    WHERE id = ${jobId}
    LIMIT 1
  `);
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

async function insertOutbox(
  executor: DurableJobQueryExecutor,
  job: TerminalDurableJob,
) {
  if (!job.runInbox) return;
  const completion: RunInboxCompletion = {
    idempotencyKey: `durable-job:${job.id}:terminal`,
    runId: job.runInbox.runId,
    correlationId: job.runInbox.correlationId,
    jobId: job.id,
    target: job.target,
    outcome: job.outcome,
  };
  await executor.execute(sql`
    INSERT INTO durable_job_completion_outbox
      (id, job_id, idempotency_key, completion)
    VALUES
      (${crypto.randomUUID()}, ${job.id}, ${completion.idempotencyKey},
       ${JSON.stringify(completion)}::jsonb)
    ON CONFLICT (idempotency_key) DO NOTHING
  `);
}

export function createPgDurableJobRepository(
  db: DurableJobQueryExecutor,
): DurableJobPgRepository {
  return {
    async create(input: CreateDurableJobInput) {
      assertAllowedDurableJobTarget(input.target);
      const inserted = await db.execute(sql`
        INSERT INTO durable_job
          (id, idempotency_key, target, payload, run_id, correlation_id,
           max_attempts)
        VALUES
          (${input.id}, ${input.idempotencyKey},
           ${JSON.stringify(input.target)}::jsonb,
           ${JSON.stringify(input.payload ?? null)}::jsonb,
           ${input.runInbox?.runId ?? null},
           ${input.runInbox?.correlationId ?? null},
           CASE
             WHEN ${JSON.stringify(input.target)}::jsonb ->> 'jobType'
                  = 'capability-orchestration' THEN 1
             ELSE 5
           END)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING ${jobProjection}
      `);
      if (inserted.rows[0]) {
        return { kind: "created", job: mapJob(inserted.rows[0]) };
      }
      const existing = await db.execute(sql`
        SELECT ${jobProjection}
        FROM durable_job
        WHERE idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `);
      if (!existing.rows[0]) throw new Error("DURABLE_JOB_CREATE_CONFLICT");
      return { kind: "existing", job: mapJob(existing.rows[0]) };
    },

    async claim({ workerId, leaseDurationMs }) {
      await this.failExpiredMaxAttempts();
      const leaseToken = crypto.randomUUID();
      const result = await db.execute(sql`
        WITH candidate AS (
          SELECT id
          FROM durable_job
          WHERE next_attempt_at <= CURRENT_TIMESTAMP
            AND (
              (status = 'queued' AND attempt < max_attempts)
              OR (
                status = 'running'
                AND lease_expires_at <= CURRENT_TIMESTAMP
                AND attempt < max_attempts
              )
            )
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE durable_job j
        SET status = 'running',
            attempt = j.attempt + 1,
            lease_token = ${leaseToken},
            lease_owner = ${workerId},
            lease_expires_at = CURRENT_TIMESTAMP
              + (${leaseDurationMs} * INTERVAL '1 millisecond'),
            updated_at = CURRENT_TIMESTAMP
        FROM candidate
        WHERE j.id = candidate.id
        RETURNING ${claimedJobProjection}
      `);
      if (!result.rows[0]) return null;
      const job = mapJob(result.rows[0]);
      return { job, token: leaseToken } as DurableJobLease;
    },

    async heartbeat({ jobId, leaseToken, leaseDurationMs }) {
      const result = await db.execute(sql`
        UPDATE durable_job
        SET lease_expires_at = CURRENT_TIMESTAMP
              + (${leaseDurationMs} * INTERVAL '1 millisecond'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${jobId}
          AND status = 'running'
          AND lease_token = ${leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING ${jobProjection}
      `);
      if (result.rows[0]) {
        const job = mapJob(result.rows[0]);
        return {
          kind: "active",
          lease: { job, token: leaseToken } as DurableJobLease,
        } satisfies DurableJobHeartbeatResult;
      }
      return (await selectJob(db, jobId))
        ? { kind: "lease_lost" }
        : { kind: "not_found" };
    },

    async failExpiredMaxAttempts() {
      return db.transaction(async (tx) => {
        const jobs = await tx
          .execute(sql`
            SELECT ${jobProjection}
            FROM durable_job
            WHERE status = 'running'
              AND attempt >= max_attempts
              AND lease_expires_at <= CURRENT_TIMESTAMP
            FOR UPDATE SKIP LOCKED
          `);
        let failed = 0;
        for (const row of jobs.rows) {
          const job = mapJob(row);
          const terminalJob = terminal({
            ...job,
            status: "failed",
            outcome: {
              status: "failed",
              error: "Durable job lease expired after its final attempt",
              errorCode: "LEASE_EXPIRED",
            },
          });
          await tx.execute(sql`
            UPDATE durable_job
            SET status = 'failed',
                outcome = ${JSON.stringify(terminalJob.outcome)}::jsonb,
                finished_lease_token = lease_token,
                lease_token = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ${job.id}
              AND status = 'running'
              AND attempt >= max_attempts
              AND lease_expires_at <= CURRENT_TIMESTAMP
          `);
          await insertOutbox(tx, terminalJob);
          failed += 1;
        }
        return failed;
      });
    },

    async finish({ jobId, leaseToken, outcome }) {
      return db.transaction(async (tx) => {
        const current = await selectJob(tx, jobId);
        if (!current) return { kind: "not_found" };
        const replay = await tx.execute(sql`
          SELECT finished_lease_token AS "finishedLeaseToken",
                 outcome = ${JSON.stringify(outcome)}::jsonb AS "outcomeMatches"
          FROM durable_job
          WHERE id = ${jobId}
        `);
        if (replay.rows[0]?.finishedLeaseToken === leaseToken) {
          return replay.rows[0].outcomeMatches
            ? { kind: "replayed", job: terminal(current) }
            : { kind: "conflict" };
        }
        const updated = await tx.execute(sql`
          UPDATE durable_job
          SET status = ${outcome.status},
              outcome = ${JSON.stringify(outcome)}::jsonb,
              finished_lease_token = lease_token,
              lease_token = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${jobId}
            AND status = 'running'
            AND lease_token = ${leaseToken}
            AND lease_expires_at > CURRENT_TIMESTAMP
          RETURNING ${jobProjection}
        `);
        if (!updated.rows[0]) return { kind: "lease_lost" };
        const job = terminal(mapJob(updated.rows[0]));
        await insertOutbox(tx, job);
        return { kind: "applied", job };
      }) as Promise<DurableJobMutationResult>;
    },

    async cancel({ jobId, reason }) {
      return db.transaction(async (tx) => {
        const current = await selectJob(tx, jobId);
        if (!current) return { kind: "not_found" };
        if (current.status === "cancelled") {
          return { kind: "replayed", job: terminal(current) };
        }
        if (current.outcome) return { kind: "conflict" };
        const outcome = { status: "cancelled" as const, reason };
        const updated = await tx.execute(sql`
          UPDATE durable_job
          SET status = 'cancelled',
              outcome = ${JSON.stringify(outcome)}::jsonb,
              lease_token = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${jobId}
            AND status IN ('queued', 'running')
          RETURNING ${jobProjection}
        `);
        if (!updated.rows[0]) return { kind: "conflict" };
        const job = terminal(mapJob(updated.rows[0]));
        await insertOutbox(tx, job);
        return { kind: "applied", job };
      }) as Promise<DurableJobMutationResult>;
    },

    async retry({ jobId, leaseToken, error, errorCode, delayMs }) {
      return db.transaction(async (tx) => {
        const updated = await tx.execute(sql`
          UPDATE durable_job
          SET status = CASE
                WHEN attempt >= max_attempts THEN 'failed'
                ELSE 'queued'
              END,
              outcome = CASE
                WHEN attempt >= max_attempts THEN
                  jsonb_build_object(
                    'status', 'failed', 'error', ${error},
                    'errorCode', ${errorCode ?? "RETRY_EXHAUSTED"}
                  )
                ELSE NULL
              END,
              next_attempt_at = CURRENT_TIMESTAMP
                + (${delayMs} * INTERVAL '1 millisecond'),
              finished_lease_token = CASE
                WHEN attempt >= max_attempts THEN lease_token
                ELSE finished_lease_token
              END,
              lease_token = NULL,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ${jobId}
            AND status = 'running'
            AND lease_token = ${leaseToken}
            AND lease_expires_at > CURRENT_TIMESTAMP
          RETURNING ${jobProjection}
        `);
        if (!updated.rows[0]) {
          return (await selectJob(tx, jobId))
            ? { kind: "lease_lost" as const }
            : { kind: "not_found" as const };
        }
        const job = mapJob(updated.rows[0]);
        if (job.status !== "failed") {
          return { kind: "retry_scheduled" as const, job };
        }
        const exhausted = terminal(job);
        await insertOutbox(tx, exhausted);
        return { kind: "exhausted" as const, job: exhausted };
      });
    },

    async claimCompletionOutbox({ leaseDurationMs }) {
      const leaseToken = crypto.randomUUID();
      const result = await db.execute(sql`
        WITH candidate AS (
          SELECT id
          FROM durable_job_completion_outbox
          WHERE delivered_at IS NULL
            AND next_attempt_at <= CURRENT_TIMESTAMP
            AND attempt < 10
            AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
          ORDER BY next_attempt_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE durable_job_completion_outbox o
        SET lease_token = ${leaseToken},
            lease_expires_at = CURRENT_TIMESTAMP
              + (${leaseDurationMs} * INTERVAL '1 millisecond'),
            attempt = o.attempt + 1,
            updated_at = CURRENT_TIMESTAMP
        FROM candidate
        WHERE o.id = candidate.id
        RETURNING o.id, o.completion, o.lease_token AS "leaseToken"
      `);
      return (result.rows[0] as DurableJobOutboxLease | undefined) ?? null;
    },

    async completeCompletionOutbox({ id, leaseToken }) {
      const result = await db.execute(sql`
        UPDATE durable_job_completion_outbox
        SET delivered_at = CURRENT_TIMESTAMP,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
          AND delivered_at IS NULL
          AND lease_token = ${leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING id
      `);
      return Boolean(result.rows[0]);
    },

    async retryCompletionOutbox({ id, leaseToken, error, delayMs }) {
      const result = await db.execute(sql`
        UPDATE durable_job_completion_outbox
        SET last_error = ${error},
            next_attempt_at = CURRENT_TIMESTAMP
              + (${delayMs} * INTERVAL '1 millisecond'),
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id}
          AND delivered_at IS NULL
          AND lease_token = ${leaseToken}
          AND lease_expires_at > CURRENT_TIMESTAMP
        RETURNING id
      `);
      return Boolean(result.rows[0]);
    },
  };
}

export const pgDurableJobRepository = createPgDurableJobRepository(
  pgDb as unknown as DurableJobQueryExecutor,
);
