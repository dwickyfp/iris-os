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
    completionFailed: z.coerce.number(),
  }),
  budgets: z.object({
    exhaustedRoots: z.coerce.number(),
    exhaustedChildren: z.coerce.number(),
    exhaustedRootsLastHour: z.coerce.number(),
    exhaustedChildrenLastHour: z.coerce.number(),
    expiredReservationsReleased: z.coerce.number(),
  }),
  delegations: z.object({
    statuses: countMap,
    depths: countMap,
    activeChildren: z.coerce.number(),
    total: z.coerce.number(),
  }),
  capabilityHealth: countMap,
  sandbox: z.object({
    sessions: countMap,
    executions: countMap,
    forcedDestroy: z.coerce.number(),
    sessionReaped: z.coerce.number(),
    timeouts: z.coerce.number(),
    artifactRejections: z.coerce.number(),
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

export const SNAPSHOT_SQL = `
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
    )),
    'completionFailed', (SELECT count(*) FROM iris_activity_event WHERE event_type = 'verification.failed')
  ),
  'budgets', jsonb_build_object(
    'exhaustedRoots', (SELECT count(*) FROM agent_run WHERE status = 'budget_exhausted' AND depth = 0),
    'exhaustedChildren', (SELECT count(*) FROM agent_run WHERE status = 'budget_exhausted' AND depth > 0),
    'exhaustedRootsLastHour', (SELECT count(*) FROM agent_run WHERE status = 'budget_exhausted' AND depth = 0 AND completed_at >= CURRENT_TIMESTAMP - interval '1 hour'),
    'exhaustedChildrenLastHour', (SELECT count(*) FROM agent_run WHERE status = 'budget_exhausted' AND depth > 0 AND completed_at >= CURRENT_TIMESTAMP - interval '1 hour'),
    'expiredReservationsReleased', (SELECT count(*) FROM root_run_budget_reservation WHERE state = 'released' AND settled_at >= expires_at)
  ),
  'delegations', jsonb_build_object(
    'statuses', COALESCE((SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, count(*)::int AS count FROM delegation_run GROUP BY status
    ) counts), '{}'::jsonb),
    'depths', COALESCE((SELECT jsonb_object_agg(depth::text, count) FROM (
      SELECT child.depth, count(*)::int AS count
      FROM delegation_run delegation
      JOIN agent_run child ON child.id = delegation.child_run_id
      GROUP BY child.depth
    ) counts), '{}'::jsonb),
    'activeChildren', (SELECT count(*) FROM delegation_run WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_input', 'waiting_external')),
    'total', (SELECT count(*) FROM delegation_run)
  ),
  'capabilityHealth', (SELECT jsonb_build_object(
    'healthy', count(*) FILTER (WHERE status = 'active' AND agent_card IS NOT NULL AND discovered_at >= CURRENT_TIMESTAMP - interval '24 hours' AND NOT (CASE WHEN jsonb_typeof(agent_card::jsonb->'security') = 'array' THEN jsonb_array_length(agent_card::jsonb->'security') > 0 ELSE false END AND (credential_type IS NULL OR encrypted_credential IS NULL))),
    'degraded', count(*) FILTER (WHERE status = 'active' AND agent_card IS NOT NULL AND discovered_at < CURRENT_TIMESTAMP - interval '24 hours' AND NOT (CASE WHEN jsonb_typeof(agent_card::jsonb->'security') = 'array' THEN jsonb_array_length(agent_card::jsonb->'security') > 0 ELSE false END AND (credential_type IS NULL OR encrypted_credential IS NULL))),
    'auth_required', count(*) FILTER (WHERE status = 'active' AND agent_card IS NOT NULL AND CASE WHEN jsonb_typeof(agent_card::jsonb->'security') = 'array' THEN jsonb_array_length(agent_card::jsonb->'security') > 0 ELSE false END AND (credential_type IS NULL OR encrypted_credential IS NULL)),
    'unavailable', count(*) FILTER (WHERE status = 'active' AND (agent_card IS NULL OR discovered_at IS NULL)),
    'disabled', count(*) FILTER (WHERE status = 'disabled')
  ) FROM remote_agent),
  'sandbox', jsonb_build_object(
    'sessions', COALESCE((SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, count(*)::int AS count FROM sandbox_session GROUP BY status
    ) counts), '{}'::jsonb),
    'executions', COALESCE((SELECT jsonb_object_agg(status, count) FROM (
      SELECT status, count(*)::int AS count FROM sandbox_execution GROUP BY status
    ) counts), '{}'::jsonb),
    'forcedDestroy', (SELECT count(*) FROM sandbox_session WHERE error_code IN ('SANDBOX_TIMED_OUT', 'SANDBOX_SESSION_LOST')),
    'sessionReaped', (SELECT count(*) FROM iris_activity_event WHERE event_type = 'sandbox.session_reaped'),
    'timeouts', (SELECT count(*) FROM sandbox_execution WHERE status = 'timed_out'),
    'artifactRejections', (SELECT count(*) FROM sandbox_execution WHERE error_code LIKE 'SANDBOX_ARTIFACT_%' AND error_code <> 'SANDBOX_ARTIFACT_CAPTURE_FAILED')
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
