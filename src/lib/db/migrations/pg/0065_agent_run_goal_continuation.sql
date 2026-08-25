ALTER TABLE "agent_run_checkpoint" ALTER COLUMN "assistant_message_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_checkpoint" ADD COLUMN "continuation_kind" varchar(32) DEFAULT 'delegation' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_checkpoint" ADD COLUMN "goal_round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_checkpoint" ADD COLUMN "max_goal_rounds" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_checkpoint" ADD COLUMN "verification_feedback" json;--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "goal_requirement" json;--> statement-breakpoint
UPDATE "agent_run" SET "goal_requirement" = "context" -> 'goalRequirement' WHERE "context" -> 'goalRequirement' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run_checkpoint" ADD CONSTRAINT "agent_run_checkpoint_continuation_kind_check" CHECK ("agent_run_checkpoint"."continuation_kind" IN ('delegation','goal'));--> statement-breakpoint
ALTER TABLE "agent_run_checkpoint" ADD CONSTRAINT "agent_run_checkpoint_goal_round_check" CHECK ("agent_run_checkpoint"."goal_round" > 0 AND "agent_run_checkpoint"."max_goal_rounds" > 0 AND "agent_run_checkpoint"."goal_round" <= "agent_run_checkpoint"."max_goal_rounds");--> statement-breakpoint
ALTER TABLE "agent_run_checkpoint" ADD CONSTRAINT "agent_run_checkpoint_feedback_check" CHECK (("agent_run_checkpoint"."continuation_kind" = 'goal' AND "agent_run_checkpoint"."verification_feedback" IS NOT NULL) OR ("agent_run_checkpoint"."continuation_kind" = 'delegation' AND "agent_run_checkpoint"."verification_feedback" IS NULL));
