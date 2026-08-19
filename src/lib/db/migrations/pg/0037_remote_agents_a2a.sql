CREATE TABLE "remote_agent" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" varchar(120) NOT NULL,
  "endpoint_url" text NOT NULL,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "credential_type" varchar(16),
  "credential_header" varchar(128),
  "encrypted_credential" text,
  "agent_card" json,
  "discovered_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "remote_agent_user_endpoint_unique" UNIQUE("user_id", "endpoint_url"),
  CONSTRAINT "remote_agent_status_check" CHECK ("status" IN ('active', 'disabled')),
  CONSTRAINT "remote_agent_credential_type_check" CHECK (
    "credential_type" IS NULL OR "credential_type" IN ('bearer', 'api_key')
  ),
  CONSTRAINT "remote_agent_credential_check" CHECK (
    ("credential_type" IS NULL AND "credential_header" IS NULL AND "encrypted_credential" IS NULL)
    OR ("credential_type" = 'bearer' AND "credential_header" IS NULL AND "encrypted_credential" IS NOT NULL)
    OR ("credential_type" = 'api_key' AND "credential_header" IS NOT NULL AND "encrypted_credential" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX "remote_agent_user_status_idx"
  ON "remote_agent" ("user_id", "status");
