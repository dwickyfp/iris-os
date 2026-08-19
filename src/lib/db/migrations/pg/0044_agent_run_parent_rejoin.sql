CREATE TABLE "agent_run_join" (
  "parent_run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "tool_call_id" varchar(240) NOT NULL,
  "child_run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "observation" json,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_run_join_parent_tool_unique" UNIQUE("parent_run_id", "tool_call_id"),
  CONSTRAINT "agent_run_join_child_unique" UNIQUE("child_run_id"),
  CONSTRAINT "agent_run_join_observation_check" CHECK (("observation" IS NULL) = ("completed_at" IS NULL))
);

CREATE INDEX "agent_run_join_parent_pending_idx"
  ON "agent_run_join" ("parent_run_id", "completed_at");

CREATE TABLE "agent_run_checkpoint" (
  "parent_run_id" uuid PRIMARY KEY REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL DEFAULT 1,
  "response_messages" json NOT NULL,
  "model_messages" json NOT NULL,
  "model_config" json NOT NULL,
  "authorization_recipe" json NOT NULL,
  "assistant_message_id" text NOT NULL,
  "claim_token" uuid,
  "claim_expires_at" timestamp,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_run_checkpoint_generation_check" CHECK ("generation" > 0),
  CONSTRAINT "agent_run_checkpoint_claim_check" CHECK (("claim_token" IS NULL) = ("claim_expires_at" IS NULL))
);

CREATE INDEX "agent_run_checkpoint_claim_idx"
  ON "agent_run_checkpoint" ("completed_at", "claim_expires_at");

CREATE TABLE "agent_run_resume_dispatch" (
  "parent_run_id" uuid PRIMARY KEY REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "generation" integer NOT NULL,
  "available_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatched_at" timestamp,
  "attempts" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_run_resume_dispatch_generation_check" CHECK ("generation" > 0)
);

CREATE INDEX "agent_run_resume_dispatch_pending_idx"
  ON "agent_run_resume_dispatch" ("dispatched_at", "available_at");
