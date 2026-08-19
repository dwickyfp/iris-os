import "server-only";

import { Pool } from "pg";
import { z } from "zod";
import type { OperationsConfig } from "./config";
import {
  DRIZZLE_MIGRATION_READY_SQL,
  getExpectedLatestMigration,
} from "./migration-status";

const countMap = z.record(z.string(), z.coerce.number()).default({});
const snapshotSchema = z.object({
  capturedAt: z.coerce.date(),
  database: z.object({ migrationReady: z.boolean() }),
  runs: countMap,
  waiting: countMap,
  leases: z.object({ active: z.coerce.number(), expired: z.coerce.number() }),
  outboxes: z.object({
    dispatch: z.coerce.number(),
    remoteCancel: z.coerce.number(),
    parentResume: z.coerce.number(),
  }),
  activity: countMap,
  verification: z.object({
    passed: z.coerce.number(),
    failed: z.coerce.number(),
    missing: z.coerce.number(),
  }),
  a2a: z.object({
    agents: countMap,
    delegations: countMap,
  }),
  parentJoins: z.object({
    pending: z.coerce.number(),
    completed: z.coerce.number(),
  }),
  workers: z.object({
    active: z.coerce.number(),
    stale: z.coerce.number(),
    oldestHeartbeatAgeSeconds: z.coerce.number().nullable(),
  }),
  pgBoss: z.object({
    installed: z.boolean(),
    jobs: countMap,
  }),
});

export type OperationsSnapshot = z.infer<typeof snapshotSchema>;

const pools = new Map<string, Pool>();

function getPool(config: OperationsConfig) {
  const key = `${config.POSTGRES_URL}:${config.OPERATIONS_QUERY_TIMEOUT_MS}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = new Pool({
      connectionString: config.POSTGRES_URL,
      max: 4,
      connectionTimeoutMillis: config.OPERATIONS_QUERY_TIMEOUT_MS,
      statement_timeout: config.OPERATIONS_QUERY_TIMEOUT_MS,
      query_timeout: config.OPERATIONS_QUERY_TIMEOUT_MS,
      application_name: "iris-operations",
    });
    pools.set(key, pool);
  }
  return pool;
}

export async function getOperationsSnapshot(
  config: OperationsConfig,
): Promise<OperationsSnapshot> {
  const expectedMigration = getExpectedLatestMigration();
  const result = await getPool(config).query({
    text: SNAPSHOT_SQL,
    values: [
      config.IRIS_WORKER_STALE_AFTER_MS,
      expectedMigration.createdAt,
      expectedMigration.hash,
    ],
  });
  return snapshotSchema.parse(result.rows[0]?.snapshot);
}

export async function getOperationsMigrationStatus(
  config: OperationsConfig,
): Promise<boolean> {
  const expected = getExpectedLatestMigration();
  const result = await getPool(config).query<{ ready: boolean }>({
    text: DRIZZLE_MIGRATION_READY_SQL,
    values: [expected.createdAt, expected.hash],
  });
  return result.rows[0]?.ready === true;
}

const SNAPSHOT_SQL = `
SELECT jsonb_build_object(
  'capturedAt', CURRENT_TIMESTAMP,
  'database', jsonb_build_object(
    'migrationReady', COALESCE((
      SELECT created_at = $2 AND hash = $3
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ), false)
  ),
  'runs', COALESCE((
    SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, count(*)::int AS count FROM agent_run GROUP BY status
    ) counts
  ), '{}'::jsonb),
  'waiting', COALESCE((
    SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, count(*)::int AS count FROM agent_run
      WHERE status IN ('waiting_approval', 'waiting_input', 'waiting_external')
      GROUP BY status
    ) counts
  ), '{}'::jsonb),
  'leases', (SELECT jsonb_build_object(
    'active', count(*) FILTER (WHERE lease_expires_at > CURRENT_TIMESTAMP),
    'expired', count(*) FILTER (WHERE lease_expires_at <= CURRENT_TIMESTAMP)
  ) FROM agent_run WHERE status = 'running'),
  'outboxes', jsonb_build_object(
    'dispatch', (SELECT count(*) FROM agent_run_dispatch WHERE dispatched_at IS NULL AND available_at <= CURRENT_TIMESTAMP),
    'remoteCancel', (SELECT count(*) FROM agent_run_remote_cancel WHERE completed_at IS NULL AND available_at <= CURRENT_TIMESTAMP),
    'parentResume', (SELECT count(*) FROM agent_run_resume_dispatch WHERE dispatched_at IS NULL AND available_at <= CURRENT_TIMESTAMP)
  ),
  'activity', COALESCE((
    SELECT jsonb_object_agg(processing_status, count) FROM (
      SELECT processing_status, count(*)::int AS count
      FROM iris_activity_event GROUP BY processing_status
    ) counts
  ), '{}'::jsonb),
  'verification', jsonb_build_object(
    'passed', (SELECT count(*) FROM artifact_verification WHERE verified),
    'failed', (SELECT count(*) FROM artifact_verification WHERE NOT verified),
    'missing', (SELECT count(*) FROM artifact a WHERE NOT EXISTS (
      SELECT 1 FROM artifact_verification v WHERE v.artifact_id = a.id
    ))
  ),
  'a2a', jsonb_build_object(
    'agents', COALESCE((SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, count(*)::int AS count FROM remote_agent GROUP BY status
    ) counts), '{}'::jsonb),
    'delegations', COALESCE((SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, count(*)::int AS count FROM delegation_run
      WHERE target_kind = 'remote_agent' GROUP BY status
    ) counts), '{}'::jsonb)
  ),
  'parentJoins', (SELECT jsonb_build_object(
    'pending', count(*) FILTER (WHERE completed_at IS NULL),
    'completed', count(*) FILTER (WHERE completed_at IS NOT NULL)
  ) FROM agent_run_join),
  'workers', (SELECT jsonb_build_object(
    'active', count(*) FILTER (WHERE last_heartbeat_at > CURRENT_TIMESTAMP - ($1::int * interval '1 millisecond')),
    'stale', count(*) FILTER (WHERE last_heartbeat_at <= CURRENT_TIMESTAMP - ($1::int * interval '1 millisecond')),
    'oldestHeartbeatAgeSeconds', CASE WHEN count(*) = 0 THEN NULL
      ELSE EXTRACT(EPOCH FROM CURRENT_TIMESTAMP - min(last_heartbeat_at)) END
  ) FROM iris_worker_heartbeat),
  'pgBoss', iris_pgboss_snapshot()
) AS snapshot`;
