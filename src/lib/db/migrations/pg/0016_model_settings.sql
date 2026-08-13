CREATE TABLE IF NOT EXISTS "model_provider" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "type" varchar(32) NOT NULL,
  "base_url" text,
  "encrypted_api_key" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "last_connection_status" varchar(16),
  "last_connection_error" text,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "model_provider_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_configuration" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_id" uuid NOT NULL REFERENCES "model_provider"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "api_model_id" text NOT NULL,
  "api_version" text,
  "context_window" integer DEFAULT 128000 NOT NULL,
  "capabilities" json DEFAULT '{"toolCalls":true,"vision":false,"structuredOutput":true}'::json NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "model_configuration_provider_id_name_unique" UNIQUE("provider_id", "name")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "model_configuration_provider_idx" ON "model_configuration" USING btree ("provider_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_thread_context" (
  "thread_id" uuid PRIMARY KEY NOT NULL REFERENCES "chat_thread"("id") ON DELETE cascade,
  "summary" text DEFAULT '' NOT NULL,
  "summarized_until" timestamp,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
