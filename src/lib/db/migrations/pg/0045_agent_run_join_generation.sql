ALTER TABLE "agent_run_join"
  ADD COLUMN "checkpoint_generation" integer NOT NULL DEFAULT 1;

ALTER TABLE "agent_run_join"
  ADD CONSTRAINT "agent_run_join_checkpoint_generation_check"
  CHECK ("checkpoint_generation" > 0);

CREATE INDEX "agent_run_join_parent_generation_idx"
  ON "agent_run_join" ("parent_run_id", "checkpoint_generation");
