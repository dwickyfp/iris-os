ALTER TABLE "automation" ADD COLUMN "timeout_ms" integer DEFAULT 300000 NOT NULL;
ALTER TABLE "automation" ADD CONSTRAINT "automation_timeout_check"
  CHECK ("timeout_ms" BETWEEN 1000 AND 3600000);
ALTER TABLE "automation_run" DROP CONSTRAINT IF EXISTS "automation_run_status_check";
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_status_check"
  CHECK ("status" IN ('queued','awaiting_approval','running','retry_scheduled','succeeded','failed','cancelled','timed_out'));
ALTER TABLE "automation_run" ADD COLUMN "approval_status" varchar DEFAULT 'not_required' NOT NULL;
ALTER TABLE "automation_run" ADD COLUMN "approved_by" uuid REFERENCES "user"("id") ON DELETE SET NULL;
ALTER TABLE "automation_run" ADD COLUMN "approved_at" timestamp;
ALTER TABLE "automation_run" ADD COLUMN "cancel_requested_at" timestamp;
ALTER TABLE "automation_run" ADD COLUMN "next_attempt_at" timestamp;
ALTER TABLE "automation_run" ADD COLUMN "error_code" varchar(120);
ALTER TABLE "automation_run" ADD COLUMN "retryable" boolean DEFAULT false NOT NULL;
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_approval_status_check"
  CHECK ("approval_status" IN ('not_required','pending','approved','rejected'));
--> statement-breakpoint
CREATE TABLE "automation_run_attempt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "automation_run"("id") ON DELETE cascade,
  "attempt" integer NOT NULL,
  "status" varchar NOT NULL CHECK ("status" IN ('running','succeeded','failed','cancelled','timed_out')),
  "result" json,
  "error_code" varchar(120),
  "error" text,
  "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "completed_at" timestamp,
  UNIQUE ("run_id", "attempt")
);
CREATE INDEX "automation_run_attempt_history_idx"
  ON "automation_run_attempt" ("run_id", "attempt");
CREATE INDEX "automation_run_delivery_idx"
  ON "automation_run" ("status", "next_attempt_at", "created_at");
