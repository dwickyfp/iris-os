ALTER TABLE "iris_activity_event" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;
ALTER TABLE "iris_activity_event" ADD COLUMN "processing_status" varchar DEFAULT 'pending' NOT NULL;
ALTER TABLE "iris_activity_event" ADD COLUMN "claimed_at" timestamp;
ALTER TABLE "iris_activity_event" ADD COLUMN "claim_expires_at" timestamp;
ALTER TABLE "iris_activity_event" ADD COLUMN "next_attempt_at" timestamp;
ALTER TABLE "iris_activity_event" ADD COLUMN "last_error" text;
UPDATE "iris_activity_event"
SET "processing_status" = CASE WHEN "processed_at" IS NULL THEN 'pending' ELSE 'processed' END;
ALTER TABLE "iris_activity_event" ADD CONSTRAINT "iris_activity_processing_status_check"
  CHECK ("processing_status" IN ('pending','processing','processed','failed'));
ALTER TABLE "iris_activity_event" ADD CONSTRAINT "iris_activity_schema_version_check"
  CHECK ("schema_version" BETWEEN 1 AND 20);
--> statement-breakpoint
CREATE INDEX "iris_activity_delivery_idx" ON "iris_activity_event"
  ("processing_status", "next_attempt_at", "claim_expires_at", "created_at");
