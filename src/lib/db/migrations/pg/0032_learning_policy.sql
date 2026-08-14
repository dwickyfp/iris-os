ALTER TABLE "learning_candidate" DROP CONSTRAINT IF EXISTS "learning_candidate_status_check";
ALTER TABLE "learning_candidate" ADD CONSTRAINT "learning_candidate_status_check"
  CHECK ("status" IN ('collecting','pending','processing','confirmed','ignored','superseded'));
ALTER TABLE "learning_candidate" ADD COLUMN "evidence_count" integer DEFAULT 1 NOT NULL;
ALTER TABLE "learning_candidate" ADD COLUMN "first_observed_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "learning_candidate" ADD COLUMN "last_observed_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "learning_candidate" ADD CONSTRAINT "learning_candidate_evidence_count_check"
  CHECK ("evidence_count" >= 1);
--> statement-breakpoint
CREATE TABLE "learning_candidate_evidence" (
  "candidate_id" uuid NOT NULL REFERENCES "learning_candidate"("id") ON DELETE cascade,
  "observation_id" uuid NOT NULL REFERENCES "learning_observation"("id") ON DELETE cascade,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY ("candidate_id", "observation_id")
);
CREATE INDEX "learning_candidate_evidence_observation_idx"
  ON "learning_candidate_evidence" ("observation_id");
--> statement-breakpoint
CREATE TABLE "learning_setting" (
  "user_id" uuid PRIMARY KEY REFERENCES "user"("id") ON DELETE cascade,
  "enabled" boolean DEFAULT true NOT NULL,
  "allowed_scopes" json DEFAULT '["global","workspace","task","agent"]'::json NOT NULL,
  "allowed_categories" json DEFAULT '["memory","skill","automation"]'::json NOT NULL,
  "retention_days" integer DEFAULT 90 NOT NULL,
  "autonomy_level" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CHECK ("retention_days" BETWEEN 1 AND 3650),
  CHECK ("autonomy_level" BETWEEN 0 AND 4)
);
CREATE TABLE "learning_suppression" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "scope_type" varchar NOT NULL,
  "scope_id" uuid,
  "candidate_type" varchar NOT NULL CHECK ("candidate_type" IN ('memory','skill','automation')),
  "suppression_key" varchar(64) NOT NULL,
  "reason" varchar(240),
  "expires_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "learning_suppression_exact_scope_uidx"
  ON "learning_suppression" ("user_id", "scope_type", "scope_id", "candidate_type", "suppression_key") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE TABLE "skill_revision" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_id" uuid NOT NULL REFERENCES "skill"("id") ON DELETE cascade,
  "source_candidate_id" uuid REFERENCES "learning_candidate"("id") ON DELETE SET NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "version" integer NOT NULL,
  "status" varchar NOT NULL CHECK ("status" IN ('proposed','approved','rejected')),
  "snapshot" json NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "reviewed_at" timestamp,
  UNIQUE ("skill_id", "version")
);
CREATE INDEX "skill_revision_history_idx" ON "skill_revision" ("skill_id", "version");
