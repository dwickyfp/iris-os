ALTER TABLE "memory_curator_run" ADD COLUMN "job_key" varchar(240);
ALTER TABLE "memory_curator_run" DROP CONSTRAINT IF EXISTS "memory_curator_run_job_type_check";
ALTER TABLE "memory_curator_run" ADD CONSTRAINT "memory_curator_run_job_type_check"
  CHECK ("job_type" IN ('extract','curate','sweep','reembed','review','consolidate'));
CREATE UNIQUE INDEX "memory_curator_run_job_key_uidx"
  ON "memory_curator_run" ("job_key") WHERE "job_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_evidence_source_uidx"
  ON "memory_evidence"
    ("user_id", "scope_type", "scope_id", "memory_id", "message_id", "content_hash")
  NULLS NOT DISTINCT
  WHERE "memory_id" IS NOT NULL;
