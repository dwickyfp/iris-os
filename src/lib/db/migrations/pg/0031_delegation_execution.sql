ALTER TABLE "agent_run" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;
ALTER TABLE "agent_run" ADD COLUMN "token_budget" integer DEFAULT 50000 NOT NULL;
ALTER TABLE "agent_run" ADD COLUMN "error_code" varchar(120);
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_depth_check" CHECK ("depth" BETWEEN 0 AND 3);
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_token_budget_check" CHECK ("token_budget" BETWEEN 1000 AND 200000);
ALTER TABLE "delegation_run" ADD COLUMN "status" varchar DEFAULT 'queued' NOT NULL;
ALTER TABLE "delegation_run" ADD COLUMN "result" json;
ALTER TABLE "delegation_run" ADD COLUMN "error_code" varchar(120);
ALTER TABLE "delegation_run" ADD COLUMN "error" text;
ALTER TABLE "delegation_run" ADD COLUMN "started_at" timestamp;
ALTER TABLE "delegation_run" ADD COLUMN "completed_at" timestamp;
ALTER TABLE "delegation_run" ADD CONSTRAINT "delegation_run_status_check"
  CHECK ("status" IN ('queued','running','succeeded','failed','cancelled','timed_out'));
CREATE INDEX "delegation_run_status_idx" ON "delegation_run" ("parent_run_id", "status", "created_at");
