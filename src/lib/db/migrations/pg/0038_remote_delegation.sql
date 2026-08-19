ALTER TABLE "delegation_run" ADD COLUMN "target_kind" varchar(24) DEFAULT 'local_agent' NOT NULL;
ALTER TABLE "delegation_run" ADD COLUMN "remote_agent_id" uuid REFERENCES "remote_agent"("id") ON DELETE SET NULL;
ALTER TABLE "delegation_run" ADD COLUMN "remote_protocol" varchar(24);
ALTER TABLE "delegation_run" ADD COLUMN "remote_task_id" varchar(512);
ALTER TABLE "delegation_run" ADD COLUMN "remote_context_id" varchar(512);
ALTER TABLE "delegation_run" ADD COLUMN "remote_status" varchar(80);
ALTER TABLE "delegation_run" ADD COLUMN "remote_metadata" json;
ALTER TABLE "delegation_run" ADD CONSTRAINT "delegation_run_target_check" CHECK (
  ("target_kind" = 'local_agent' AND "remote_agent_id" IS NULL)
  OR ("target_kind" = 'remote_agent' AND "remote_protocol" = 'a2a')
);
CREATE INDEX "delegation_run_remote_agent_idx" ON "delegation_run" ("remote_agent_id", "created_at");
CREATE UNIQUE INDEX "delegation_run_remote_task_unique" ON "delegation_run" ("remote_agent_id", "remote_task_id") WHERE "remote_task_id" IS NOT NULL;
