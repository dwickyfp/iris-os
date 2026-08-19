ALTER TABLE "agent_run" DROP CONSTRAINT IF EXISTS "agent_run_status_check";
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_status_check"
  CHECK ("status" IN ('queued','running','waiting_approval','waiting_input','waiting_external','succeeded','failed','cancelled','timed_out'));
ALTER TABLE "agent_run" ADD COLUMN "lease_token" uuid;
ALTER TABLE "agent_run" ADD COLUMN "lease_expires_at" timestamp;
ALTER TABLE "agent_run" ADD COLUMN "absolute_deadline_at" timestamp;
ALTER TABLE "agent_run" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;
UPDATE "agent_run" SET
  "lease_token" = gen_random_uuid(),
  "lease_expires_at" = CURRENT_TIMESTAMP,
  "absolute_deadline_at" = COALESCE("started_at", "created_at") + ("timeout_ms" * interval '1 millisecond'),
  "attempt" = 1
WHERE "status" = 'running';
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_lease_check" CHECK (
  ("status" = 'running' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  OR ("status" <> 'running' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
);
CREATE INDEX "agent_run_reclaim_idx" ON "agent_run" ("status", "lease_expires_at");

ALTER TABLE "delegation_run" ADD COLUMN "idempotency_key" varchar(240);
UPDATE "delegation_run" SET "idempotency_key" = "id"::text WHERE "idempotency_key" IS NULL;
ALTER TABLE "delegation_run" ALTER COLUMN "idempotency_key" SET NOT NULL;
ALTER TABLE "delegation_run" ADD COLUMN "submission_id" uuid;
ALTER TABLE "delegation_run" ADD COLUMN "message_id" uuid;
ALTER TABLE "delegation_run" ADD COLUMN "submission_payload" json;
ALTER TABLE "delegation_run" ADD COLUMN "submission_started_at" timestamp;
ALTER TABLE "delegation_run" ADD CONSTRAINT "delegation_run_parent_idempotency_unique" UNIQUE ("parent_run_id", "idempotency_key");
ALTER TABLE "delegation_run" ADD CONSTRAINT "delegation_run_submission_check" CHECK (
  ("submission_id" IS NULL AND "message_id" IS NULL AND "submission_payload" IS NULL AND "submission_started_at" IS NULL)
  OR ("submission_id" IS NOT NULL AND "message_id" IS NOT NULL AND "submission_payload" IS NOT NULL AND "submission_started_at" IS NOT NULL)
);

CREATE TABLE "agent_run_continuation" (
  "run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "kind" varchar(24) NOT NULL CHECK ("kind" IN ('input','credential')),
  "submission_id" uuid NOT NULL,
  "message_id" uuid NOT NULL,
  "payload" json,
  "encrypted_credential" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "consumed_at" timestamp,
  CONSTRAINT "agent_run_continuation_run_kind_unique" UNIQUE ("run_id", "kind"),
  CONSTRAINT "agent_run_continuation_value_check" CHECK (
    ("kind" = 'input' AND "payload" IS NOT NULL AND "encrypted_credential" IS NULL)
    OR ("kind" = 'credential' AND "payload" IS NULL AND "encrypted_credential" IS NOT NULL)
  )
);

CREATE TABLE "agent_run_dispatch" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL UNIQUE REFERENCES "agent_run"("id") ON DELETE CASCADE,
  "available_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "dispatched_at" timestamp,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX "agent_run_dispatch_pending_idx" ON "agent_run_dispatch" ("dispatched_at", "available_at");
