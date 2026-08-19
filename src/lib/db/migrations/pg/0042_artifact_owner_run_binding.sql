UPDATE "artifact" AS artifact
SET "user_id" = agent_run."user_id"
FROM "agent_run"
WHERE artifact."run_id" = agent_run."id"
  AND artifact."user_id" IS DISTINCT FROM agent_run."user_id";
--> statement-breakpoint
DELETE FROM "artifact" WHERE "user_id" IS NULL OR "run_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "artifact" ALTER COLUMN "user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifact" ALTER COLUMN "run_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifact" DROP CONSTRAINT "artifact_run_id_agent_run_id_fk";
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;
