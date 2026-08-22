ALTER TABLE "automation_run" DROP CONSTRAINT IF EXISTS "automation_run_status_check";
--> statement-breakpoint
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_status_check"
  CHECK ("status" IN ('queued','awaiting_approval','running','retry_scheduled','succeeded','failed','cancelled','timed_out','budget_exhausted'));
--> statement-breakpoint
ALTER TABLE "automation_run_attempt" DROP CONSTRAINT IF EXISTS "automation_run_attempt_status_check";
--> statement-breakpoint
ALTER TABLE "automation_run_attempt" DROP CONSTRAINT IF EXISTS "automation_run_attempt_status_check1";
--> statement-breakpoint
ALTER TABLE "automation_run_attempt" ADD CONSTRAINT "automation_run_attempt_status_check"
  CHECK ("status" IN ('running','succeeded','failed','cancelled','timed_out','budget_exhausted'));
