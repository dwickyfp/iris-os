ALTER TABLE "sandbox_execution" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_run_compute_budget" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sandbox_session" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "sandbox_execution" CASCADE;--> statement-breakpoint
DROP TABLE "sandbox_run_compute_budget" CASCADE;--> statement-breakpoint
DROP TABLE "sandbox_session" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "artifact_output_provenance_unique";--> statement-breakpoint
ALTER TABLE "root_run_budget" DROP CONSTRAINT "root_run_budget_limits_check";--> statement-breakpoint
ALTER TABLE "root_run_budget" DROP CONSTRAINT "root_run_budget_usage_check";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "output_execution_id";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "output_relative_path";--> statement-breakpoint
ALTER TABLE "root_run_budget" DROP COLUMN "max_sandbox_compute_ms";--> statement-breakpoint
ALTER TABLE "root_run_budget" DROP COLUMN "committed_sandbox_compute_ms";--> statement-breakpoint
ALTER TABLE "root_run_budget" DROP COLUMN "reserved_sandbox_compute_ms";--> statement-breakpoint
ALTER TABLE "root_run_budget" ADD CONSTRAINT "root_run_budget_limits_check" CHECK ("root_run_budget"."max_steps" > 0 AND "root_run_budget"."max_tokens" > 0 AND "root_run_budget"."max_duration_ms" > 0 AND "root_run_budget"."max_tool_calls" >= 0 AND "root_run_budget"."max_delegations" >= 0 AND "root_run_budget"."max_delegation_depth" >= 0 AND "root_run_budget"."max_parallel_children" >= 0);--> statement-breakpoint
ALTER TABLE "root_run_budget" ADD CONSTRAINT "root_run_budget_usage_check" CHECK ("root_run_budget"."committed_steps" >= 0 AND "root_run_budget"."committed_tokens" >= 0 AND "root_run_budget"."committed_tool_calls" >= 0 AND "root_run_budget"."committed_delegations" >= 0 AND "root_run_budget"."committed_children" >= 0 AND "root_run_budget"."reserved_steps" >= 0 AND "root_run_budget"."reserved_tokens" >= 0 AND "root_run_budget"."reserved_tool_calls" >= 0 AND "root_run_budget"."reserved_delegations" >= 0 AND "root_run_budget"."reserved_children" >= 0 AND "root_run_budget"."committed_steps" + "root_run_budget"."reserved_steps" <= "root_run_budget"."max_steps" AND "root_run_budget"."committed_tokens" + "root_run_budget"."reserved_tokens" <= "root_run_budget"."max_tokens" AND "root_run_budget"."committed_tool_calls" + "root_run_budget"."reserved_tool_calls" <= "root_run_budget"."max_tool_calls" AND "root_run_budget"."committed_delegations" + "root_run_budget"."reserved_delegations" <= "root_run_budget"."max_delegations" AND "root_run_budget"."reserved_children" <= "root_run_budget"."max_parallel_children");--> statement-breakpoint
DELETE FROM "root_run_budget_reservation" WHERE "kind" = 'sandbox_compute_ms';--> statement-breakpoint
ALTER TABLE "root_run_budget_reservation" DROP CONSTRAINT "root_run_budget_reservation_kind_check";--> statement-breakpoint
ALTER TABLE "root_run_budget_reservation" ADD CONSTRAINT "root_run_budget_reservation_kind_check" CHECK ("kind" IN ('steps','tokens','tool_calls','delegations','children'));
