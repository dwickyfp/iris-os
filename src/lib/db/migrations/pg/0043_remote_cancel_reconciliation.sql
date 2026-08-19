CREATE TABLE "agent_run_remote_cancel" (
  "run_id" uuid PRIMARY KEY NOT NULL REFERENCES "agent_run"("id") ON DELETE cascade,
  "available_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "dispatched_at" timestamp,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "remote_outcome" json,
  "completed_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_run_remote_cancel_pending_idx" ON "agent_run_remote_cancel" ("completed_at", "dispatched_at", "available_at");
