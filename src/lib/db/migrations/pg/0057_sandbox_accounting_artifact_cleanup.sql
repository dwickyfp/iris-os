ALTER TABLE "sandbox_execution" ADD COLUMN "observed_wall_duration_ms" integer;
--> statement-breakpoint
UPDATE "sandbox_execution"
SET "observed_wall_duration_ms" = "duration_ms",
    "duration_ms" = LEAST("duration_ms", "reserved_compute_ms")
WHERE "duration_ms" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "sandbox_execution" DROP CONSTRAINT "sandbox_execution_compute_check";
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ADD CONSTRAINT "sandbox_execution_compute_check"
  CHECK (
    "reserved_compute_ms" > 0
    AND ("duration_ms" IS NULL OR ("duration_ms" >= 0 AND "duration_ms" <= "reserved_compute_ms"))
    AND ("observed_wall_duration_ms" IS NULL OR "observed_wall_duration_ms" >= 0)
  );
--> statement-breakpoint
CREATE TABLE "artifact_cleanup" (
  "artifact_id" uuid PRIMARY KEY NOT NULL REFERENCES "artifact"("id") ON DELETE CASCADE,
  "storage_key" text NOT NULL,
  "status" varchar NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimed_at" timestamp,
  "last_error" text,
  "completed_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "artifact_cleanup_status_check" CHECK ("status" IN ('pending','processing','retrying','completed','failed')),
  CONSTRAINT "artifact_cleanup_attempts_check" CHECK ("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "artifact_cleanup_reaper_idx"
  ON "artifact_cleanup" ("status", "next_attempt_at", "claimed_at");
