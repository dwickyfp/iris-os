CREATE TABLE "artifact" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "run_id" uuid,
  "storage_key" text NOT NULL,
  "filename" varchar(240) NOT NULL,
  "media_type" varchar(160) NOT NULL,
  "size" integer NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "status" varchar DEFAULT 'active' NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "artifact_storage_key_unique" UNIQUE("storage_key"),
  CONSTRAINT "artifact_size_check" CHECK ("size" >= 0),
  CONSTRAINT "artifact_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "artifact_status_check" CHECK ("status" IN ('active','archived'))
);
--> statement-breakpoint
CREATE TABLE "artifact_verification" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "artifact_id" uuid NOT NULL,
  "verified" boolean NOT NULL,
  "reason" varchar(120),
  "details" json DEFAULT '{}'::json NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "artifact_verification_reason_check" CHECK (("verified" AND "reason" IS NULL) OR (NOT "verified" AND "reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_run_id_agent_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_run"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artifact_verification" ADD CONSTRAINT "artifact_verification_artifact_id_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "artifact_user_created_idx" ON "artifact" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "artifact_verification_artifact_idx" ON "artifact_verification" USING btree ("artifact_id","created_at");
