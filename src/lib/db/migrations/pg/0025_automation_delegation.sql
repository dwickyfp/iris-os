CREATE TABLE "automation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "workspace_id" uuid REFERENCES "workspace"("id") ON DELETE SET NULL,
  "name" varchar(160) NOT NULL,
  "status" varchar DEFAULT 'active' NOT NULL CHECK ("status" IN ('active','paused','archived')),
  "trigger_type" varchar NOT NULL CHECK ("trigger_type" IN ('manual','schedule')),
  "cron" varchar(120), "timezone" varchar(80) DEFAULT 'UTC' NOT NULL,
  "missed_run_policy" varchar DEFAULT 'skip' NOT NULL CHECK ("missed_run_policy" IN ('skip','run_once')),
  "target_type" varchar NOT NULL CHECK ("target_type" IN ('workflow','skill','agent')),
  "target_id" uuid NOT NULL,
  "approval_policy" varchar NOT NULL CHECK ("approval_policy" IN ('always','destructive_only','never')),
  "input" json DEFAULT '{}'::json NOT NULL, "retry_limit" integer DEFAULT 3 NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CHECK (("trigger_type" = 'schedule' AND "cron" IS NOT NULL) OR "trigger_type" = 'manual')
);
CREATE TABLE "automation_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_id" uuid NOT NULL REFERENCES "automation"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "idempotency_key" varchar(64) NOT NULL,
  "status" varchar DEFAULT 'queued' NOT NULL CHECK ("status" IN ('queued','running','succeeded','failed','cancelled')),
  "scheduled_for" timestamp NOT NULL, "attempt" integer DEFAULT 0 NOT NULL,
  "result" json, "error" text, "started_at" timestamp, "completed_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE ("automation_id", "idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "agent_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "agent_id" uuid REFERENCES "agent"("id") ON DELETE SET NULL,
  "parent_run_id" uuid, "workspace_id" uuid REFERENCES "workspace"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "iris_task"("id") ON DELETE SET NULL,
  "status" varchar DEFAULT 'queued' NOT NULL CHECK ("status" IN ('queued','running','succeeded','failed','cancelled','timed_out')),
  "context" json DEFAULT '{}'::json NOT NULL, "allowed_tools" json DEFAULT '[]'::json NOT NULL,
  "timeout_ms" integer DEFAULT 300000 NOT NULL, "result" json, "error" text,
  "cancel_requested_at" timestamp, "started_at" timestamp, "completed_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_parent_fk" FOREIGN KEY ("parent_run_id") REFERENCES "agent_run"("id") ON DELETE SET NULL;
CREATE TABLE "delegation_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE cascade,
  "child_run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "objective" text NOT NULL, "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE ("parent_run_id", "child_run_id")
);
--> statement-breakpoint
CREATE INDEX "automation_user_status_idx" ON "automation" ("user_id", "status");
CREATE INDEX "automation_run_history_idx" ON "automation_run" ("automation_id", "created_at" DESC);
CREATE INDEX "agent_run_parent_idx" ON "agent_run" ("parent_run_id");
