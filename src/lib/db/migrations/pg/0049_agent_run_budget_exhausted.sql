ALTER TABLE "agent_run" DROP CONSTRAINT IF EXISTS "agent_run_status_check";
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_status_check"
  CHECK ("status" IN ('queued','running','waiting_approval','waiting_input','waiting_external','succeeded','failed','cancelled','timed_out','budget_exhausted'));
ALTER TABLE "delegation_run" DROP CONSTRAINT IF EXISTS "delegation_run_status_check";
ALTER TABLE "delegation_run" ADD CONSTRAINT "delegation_run_status_check"
  CHECK ("status" IN ('queued','running','waiting_approval','waiting_input','waiting_external','succeeded','failed','cancelled','timed_out','budget_exhausted'));
