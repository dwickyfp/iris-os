CREATE TABLE "root_run_goal" (
	"root_run_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"requirement" json,
	"source_message_id" uuid,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "root_run_goal_revision_check" CHECK ("root_run_goal"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "run_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"root_run_id" uuid,
	"target_run_id" uuid,
	"mode" varchar(24) NOT NULL,
	"source" varchar(24) NOT NULL,
	"status" varchar(24) DEFAULT 'open' NOT NULL,
	"content" json NOT NULL,
	"goal_revision" integer,
	"idempotency_key" varchar(240) NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "run_inbox_user_id_idempotency_key_unique" UNIQUE("user_id","idempotency_key"),
	CONSTRAINT "run_inbox_mode_check" CHECK ("run_inbox"."mode" IN ('followup','steer','inject')),
	CONSTRAINT "run_inbox_source_check" CHECK ("run_inbox"."source" IN ('user','system','a2a','workflow','job','automation')),
	CONSTRAINT "run_inbox_status_check" CHECK ("run_inbox"."status" IN ('open','consumed','dismissed','superseded')),
	CONSTRAINT "run_inbox_goal_revision_check" CHECK ("run_inbox"."goal_revision" IS NULL OR "run_inbox"."goal_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "goal_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
INSERT INTO "root_run_goal" ("root_run_id", "revision", "requirement") SELECT "id", 1, "goal_requirement" FROM "agent_run" WHERE "id" = "root_run_id" ON CONFLICT ("root_run_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "root_run_goal" ADD CONSTRAINT "root_run_goal_root_run_id_agent_run_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_inbox" ADD CONSTRAINT "run_inbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_inbox" ADD CONSTRAINT "run_inbox_root_run_id_agent_run_id_fk" FOREIGN KEY ("root_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_inbox" ADD CONSTRAINT "run_inbox_target_run_id_agent_run_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."agent_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_inbox_user_open_idx" ON "run_inbox" USING btree ("user_id","status","created_at");--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_goal_revision_check" CHECK ("agent_run"."goal_revision" > 0);
