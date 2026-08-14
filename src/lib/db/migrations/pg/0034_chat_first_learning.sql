ALTER TABLE "learning_candidate" ADD COLUMN "promotion_claimed_at" timestamp;
ALTER TABLE "learning_candidate" ADD COLUMN "promotion_claim_expires_at" timestamp;
ALTER TABLE "learning_candidate" ADD COLUMN "promotion_next_attempt_at" timestamp;
ALTER TABLE "learning_candidate" ADD COLUMN "promotion_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "learning_candidate" ADD COLUMN "promotion_error_code" varchar(120);
ALTER TABLE "learning_candidate" ADD COLUMN "resolution_reason" varchar(240);
CREATE INDEX "learning_candidate_promotion_idx" ON "learning_candidate" ("status", "promotion_next_attempt_at", "promotion_claim_expires_at");
--> statement-breakpoint
CREATE TABLE "learning_promotion_attempt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "candidate_id" uuid NOT NULL REFERENCES "learning_candidate"("id") ON DELETE cascade,
  "attempt" integer NOT NULL,
  "status" varchar NOT NULL CHECK ("status" IN ('running','succeeded','failed','superseded')),
  "error_code" varchar(120),
  "error" text,
  "started_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "completed_at" timestamp,
  UNIQUE ("candidate_id", "attempt")
);
CREATE INDEX "learning_promotion_attempt_history_idx" ON "learning_promotion_attempt" ("candidate_id", "attempt");
--> statement-breakpoint
ALTER TABLE "learning_setting" ALTER COLUMN "allowed_categories" SET DEFAULT '["memory","skill"]'::json;
UPDATE "learning_setting"
SET "allowed_categories" = ("allowed_categories"::jsonb - 'automation')::json,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "allowed_categories"::jsonb ? 'automation';
--> statement-breakpoint
UPDATE "learning_candidate"
SET "status" = 'superseded',
    "resolution_reason" = 'duplicate_memory_pipeline',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "candidate_type" = 'memory'
  AND "status" IN ('collecting','pending','processing');
UPDATE "learning_candidate"
SET "status" = 'superseded',
    "resolution_reason" = 'inferred_automation_disabled',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "candidate_type" = 'automation'
  AND "status" IN ('collecting','pending','processing');
UPDATE "learning_candidate"
SET "status" = CASE WHEN "evidence_count" >= 3 THEN 'pending' ELSE 'collecting' END,
    "resolution_reason" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "candidate_type" = 'skill'
  AND "status" IN ('collecting','pending','processing');
