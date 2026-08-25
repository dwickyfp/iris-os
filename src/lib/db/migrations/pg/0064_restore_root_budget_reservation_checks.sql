ALTER TABLE "root_run_budget_reservation" DROP CONSTRAINT IF EXISTS "root_run_budget_reservation_kind_check";--> statement-breakpoint
ALTER TABLE "root_run_budget_reservation" DROP CONSTRAINT IF EXISTS "root_run_budget_reservation_state_check";--> statement-breakpoint
ALTER TABLE "root_run_budget_reservation" DROP CONSTRAINT IF EXISTS "root_run_budget_reservation_amount_check";--> statement-breakpoint
ALTER TABLE "root_run_budget_reservation" ADD CONSTRAINT "root_run_budget_reservation_kind_check" CHECK ("kind" IN ('steps','tokens','tool_calls','delegations','children'));--> statement-breakpoint
ALTER TABLE "root_run_budget_reservation" ADD CONSTRAINT "root_run_budget_reservation_state_check" CHECK ("state" IN ('reserved','committed','released'));--> statement-breakpoint
ALTER TABLE "root_run_budget_reservation" ADD CONSTRAINT "root_run_budget_reservation_amount_check" CHECK ("amount" > 0 AND ("committed_amount" IS NULL OR "committed_amount" BETWEEN 0 AND "amount") AND (("state" = 'reserved' AND "settled_at" IS NULL) OR ("state" <> 'reserved' AND "settled_at" IS NOT NULL)));
