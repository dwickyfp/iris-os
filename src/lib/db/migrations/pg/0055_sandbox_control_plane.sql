CREATE TABLE "sandbox_session" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "workspace_id" uuid REFERENCES "workspace"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "iris_task"("id") ON DELETE SET NULL,
  "provider" varchar(80) NOT NULL,
  "provider_instance_id" varchar(240),
  "profile" json NOT NULL,
  "status" varchar NOT NULL,
  "last_used_at" timestamp NOT NULL,
  "expires_at" timestamp NOT NULL,
  "error_code" varchar(120),
  "destroyed_at" timestamp,
  "created_at" timestamp NOT NULL,
  CONSTRAINT "sandbox_session_run_provider_unique" UNIQUE("run_id", "provider"),
  CONSTRAINT "sandbox_session_status_check" CHECK ("status" IN ('creating','active','destroying','destroyed','failed')),
  CONSTRAINT "sandbox_session_instance_check" CHECK ("status" <> 'active' OR "provider_instance_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX "sandbox_session_reaper_idx" ON "sandbox_session" ("status", "expires_at");
--> statement-breakpoint
CREATE TABLE "sandbox_execution" (
  "id" uuid PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "sandbox_session"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "status" varchar NOT NULL,
  "reserved_compute_ms" integer NOT NULL,
  "duration_ms" integer,
  "exit_code" integer,
  "error_code" varchar(120),
  "started_at" timestamp NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "sandbox_execution_status_check" CHECK ("status" IN ('running','succeeded','failed','cancelled','timed_out')),
  CONSTRAINT "sandbox_execution_compute_check" CHECK ("reserved_compute_ms" > 0 AND ("duration_ms" IS NULL OR "duration_ms" >= 0)),
  CONSTRAINT "sandbox_execution_terminal_check" CHECK (("status" = 'running' AND "completed_at" IS NULL) OR ("status" <> 'running' AND "completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "sandbox_execution_session_started_idx" ON "sandbox_execution" ("session_id", "started_at");
--> statement-breakpoint
CREATE INDEX "sandbox_execution_run_started_idx" ON "sandbox_execution" ("run_id", "started_at");
