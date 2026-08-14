CREATE TABLE "iris_activity_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "actor_type" varchar NOT NULL CHECK ("actor_type" IN ('user','agent','system')),
  "actor_id" varchar(160), "scope_type" varchar DEFAULT 'global' NOT NULL,
  "scope_id" uuid, "event_type" varchar(120) NOT NULL,
  "subject_type" varchar(80) NOT NULL, "subject_id" varchar(200),
  "payload" json DEFAULT '{}'::json NOT NULL,
  "request_id" varchar(160), "run_id" varchar(160), "parent_run_id" varchar(160),
  "thread_id" uuid REFERENCES "chat_thread"("id") ON DELETE SET NULL,
  "task_id" uuid REFERENCES "iris_task"("id") ON DELETE SET NULL,
  "agent_id" uuid REFERENCES "agent"("id") ON DELETE SET NULL,
  "idempotency_key" varchar(240) NOT NULL,
  "processed_at" timestamp, "processing_attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE ("user_id", "idempotency_key"),
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "learning_observation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "iris_activity_event"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "scope_type" varchar NOT NULL, "scope_id" uuid,
  "observation_type" varchar(80) NOT NULL, "summary" text NOT NULL,
  "evidence" json DEFAULT '{}'::json NOT NULL, "confidence" integer NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE ("event_id", "observation_type")
);
CREATE TABLE "learning_candidate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "observation_id" uuid NOT NULL REFERENCES "learning_observation"("id") ON DELETE cascade,
  "scope_type" varchar NOT NULL, "scope_id" uuid,
  "candidate_type" varchar NOT NULL CHECK ("candidate_type" IN ('memory','skill','automation')),
  "title" varchar(240) NOT NULL, "proposed_payload" json NOT NULL,
  "confidence" integer NOT NULL,
  "status" varchar DEFAULT 'pending' NOT NULL CHECK ("status" IN ('pending','processing','confirmed','ignored','superseded')),
  "suppression_key" varchar(64) NOT NULL, "promoted_type" varchar(40), "promoted_id" uuid,
  "reviewed_at" timestamp, "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE ("user_id", "suppression_key", "status")
);
CREATE TABLE "learning_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "candidate_id" uuid NOT NULL REFERENCES "learning_candidate"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "action" varchar NOT NULL CHECK ("action" IN ('confirm','edit','ignore','change_scope')),
  "payload" json DEFAULT '{}'::json NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "iris_activity_unprocessed_idx" ON "iris_activity_event" ("processed_at", "created_at");
CREATE INDEX "iris_activity_scope_idx" ON "iris_activity_event" ("user_id", "scope_type", "scope_id", "created_at" DESC);
CREATE INDEX "learning_candidate_inbox_idx" ON "learning_candidate" ("user_id", "status");
CREATE INDEX "learning_feedback_candidate_idx" ON "learning_feedback" ("candidate_id");
