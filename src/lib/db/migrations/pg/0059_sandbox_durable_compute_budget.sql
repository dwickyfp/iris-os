CREATE TABLE "sandbox_run_compute_budget" (
  "run_id" uuid PRIMARY KEY NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "max_compute_ms" integer,
  "reserved_compute_ms" integer NOT NULL DEFAULT 0,
  "committed_compute_ms" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sandbox_run_compute_budget_check" CHECK (
    ("max_compute_ms" IS NULL OR "max_compute_ms" > 0)
    AND "reserved_compute_ms" >= 0
    AND "committed_compute_ms" >= 0
    AND ("max_compute_ms" IS NULL OR "reserved_compute_ms" + "committed_compute_ms" <= "max_compute_ms")
  )
);
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ADD COLUMN "reservation_token" uuid;
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ADD COLUMN "reservation_expires_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ADD COLUMN "settlement_deadline_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ADD COLUMN "charged_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ALTER COLUMN "started_at" DROP NOT NULL;
--> statement-breakpoint
UPDATE "sandbox_execution"
SET "reservation_token" = gen_random_uuid(),
    "reservation_expires_at" = COALESCE("started_at", "completed_at", CURRENT_TIMESTAMP),
    "settlement_deadline_at" = CASE WHEN "status" = 'running'
      THEN COALESCE("started_at", CURRENT_TIMESTAMP) + ("reserved_compute_ms" * interval '1 millisecond') + interval '1 minute'
      ELSE NULL END,
    "charged_at" = CASE WHEN "duration_ms" IS NOT NULL THEN COALESCE("completed_at", CURRENT_TIMESTAMP) ELSE NULL END;
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ALTER COLUMN "reservation_token" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ALTER COLUMN "reservation_expires_at" SET NOT NULL;
--> statement-breakpoint
INSERT INTO "sandbox_run_compute_budget" ("run_id", "reserved_compute_ms", "committed_compute_ms")
SELECT "run_id",
       COALESCE(SUM("reserved_compute_ms") FILTER (WHERE "status" = 'running' AND "charged_at" IS NULL), 0)::integer,
       COALESCE(SUM("duration_ms") FILTER (WHERE "charged_at" IS NOT NULL), 0)::integer
FROM "sandbox_execution"
GROUP BY "run_id";
--> statement-breakpoint
ALTER TABLE "sandbox_execution" DROP CONSTRAINT "sandbox_execution_status_check";
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ADD CONSTRAINT "sandbox_execution_status_check"
  CHECK ("status" IN ('reserved','running','succeeded','failed','cancelled','timed_out'));
--> statement-breakpoint
ALTER TABLE "sandbox_execution" DROP CONSTRAINT "sandbox_execution_terminal_check";
--> statement-breakpoint
ALTER TABLE "sandbox_execution" ADD CONSTRAINT "sandbox_execution_terminal_check"
  CHECK (
    ("status" IN ('reserved','running') AND "completed_at" IS NULL)
    OR ("status" NOT IN ('reserved','running') AND "completed_at" IS NOT NULL)
  );
--> statement-breakpoint
CREATE INDEX "sandbox_execution_stale_reservation_idx"
  ON "sandbox_execution" ("status", "reservation_expires_at", "settlement_deadline_at")
  WHERE "charged_at" IS NULL;
