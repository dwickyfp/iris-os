ALTER TABLE "agent_run" ADD COLUMN "waiting_reason" varchar(120);
ALTER TABLE "agent_run" ADD COLUMN "last_heartbeat_at" timestamp;
ALTER TABLE "agent_run" DROP CONSTRAINT "agent_run_status_check";
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_status_check"
  CHECK ("status" IN ('queued','running','waiting_approval','waiting_input','waiting_external','succeeded','failed','cancelled','timed_out'));
ALTER TABLE "delegation_run" DROP CONSTRAINT "delegation_run_status_check";
ALTER TABLE "delegation_run" ADD CONSTRAINT "delegation_run_status_check"
  CHECK ("status" IN ('queued','running','waiting_approval','waiting_input','waiting_external','succeeded','failed','cancelled','timed_out'));
