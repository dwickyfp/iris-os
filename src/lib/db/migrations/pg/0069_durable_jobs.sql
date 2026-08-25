CREATE TABLE "durable_job_completion_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"completion" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp,
	"last_error" text,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "durable_job_completion_outbox_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "durable_job_outbox_attempt_check" CHECK ("durable_job_completion_outbox"."attempt" >= 0),
	CONSTRAINT "durable_job_outbox_lease_check" CHECK (("durable_job_completion_outbox"."lease_token" IS NULL) = ("durable_job_completion_outbox"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "durable_job" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"target" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"run_id" uuid,
	"correlation_id" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp,
	"finished_lease_token" uuid,
	"outcome" jsonb,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "durable_job_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "durable_job_status_check" CHECK ("durable_job"."status" IN ('queued','running','completed','failed','cancelled')),
	CONSTRAINT "durable_job_attempt_check" CHECK ("durable_job"."attempt" >= 0 AND "durable_job"."max_attempts" > 0),
	CONSTRAINT "durable_job_run_inbox_check" CHECK (("durable_job"."run_id" IS NULL AND "durable_job"."correlation_id" IS NULL) OR ("durable_job"."run_id" IS NOT NULL AND "durable_job"."correlation_id" IS NOT NULL)),
	CONSTRAINT "durable_job_target_check" CHECK (jsonb_typeof("durable_job"."target") = 'object' AND "durable_job"."target" ->> 'kind' = 'job' AND "durable_job"."target" ->> 'jobType' = 'capability-orchestration'),
	CONSTRAINT "durable_job_lease_check" CHECK (("durable_job"."status" = 'running' AND "durable_job"."lease_token" IS NOT NULL AND "durable_job"."lease_owner" IS NOT NULL AND "durable_job"."lease_expires_at" IS NOT NULL) OR ("durable_job"."status" <> 'running' AND "durable_job"."lease_token" IS NULL AND "durable_job"."lease_owner" IS NULL AND "durable_job"."lease_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "durable_job_completion_outbox" ADD CONSTRAINT "durable_job_completion_outbox_job_id_durable_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."durable_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "durable_job_outbox_claim_idx" ON "durable_job_completion_outbox" USING btree ("next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "durable_job_claim_idx" ON "durable_job" USING btree ("next_attempt_at","created_at");--> statement-breakpoint
CREATE INDEX "durable_job_run_idx" ON "durable_job" USING btree ("run_id");
