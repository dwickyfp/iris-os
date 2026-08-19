CREATE TABLE "iris_worker_heartbeat" (
  "worker_id" varchar(160) PRIMARY KEY NOT NULL,
  "hostname" varchar(255) NOT NULL,
  "pid" integer NOT NULL,
  "version" varchar(80) NOT NULL,
  "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "last_heartbeat_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "iris_worker_heartbeat_pid_check" CHECK ("pid" > 0)
);
--> statement-breakpoint
CREATE INDEX "iris_worker_heartbeat_last_seen_idx"
  ON "iris_worker_heartbeat" ("last_heartbeat_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION iris_pgboss_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  boss_schema text;
  job_counts jsonb := '{}'::jsonb;
BEGIN
  SELECT n.nspname INTO boss_schema
  FROM pg_namespace n
  WHERE n.nspname IN ('pgboss', 'pg_boss')
  ORDER BY CASE n.nspname WHEN 'pgboss' THEN 0 ELSE 1 END
  LIMIT 1;

  IF boss_schema IS NULL THEN
    RETURN jsonb_build_object('installed', false, 'jobs', job_counts);
  END IF;

  IF to_regclass(format('%I.job', boss_schema)) IS NOT NULL THEN
    EXECUTE format(
      'SELECT COALESCE(jsonb_object_agg(state, count), ''{}''::jsonb)
       FROM (SELECT state, count(*)::int AS count FROM %I.job GROUP BY state) counts',
      boss_schema
    ) INTO job_counts;
  END IF;

  RETURN jsonb_build_object('installed', true, 'jobs', job_counts);
END;
$$;
