CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
ALTER TABLE "skill" ADD COLUMN "provenance" varchar DEFAULT 'manual' NOT NULL;
ALTER TABLE "skill" ADD CONSTRAINT "skill_provenance_check" CHECK ("provenance" IN ('manual', 'background_review'));
--> statement-breakpoint
CREATE TABLE "chat_message_search" (
  "message_id" text PRIMARY KEY NOT NULL,
  "thread_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "kind" varchar NOT NULL,
  "content" text NOT NULL,
  "confidence" integer DEFAULT 100 NOT NULL,
  "status" varchar DEFAULT 'active' NOT NULL,
  "provenance" varchar NOT NULL,
  "source_thread_id" uuid,
  "source_message_id" text,
  "version" integer DEFAULT 1 NOT NULL,
  "expires_at" timestamp,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "user_memory_kind_check" CHECK ("kind" IN ('preference','fact','goal')),
  CONSTRAINT "user_memory_status_check" CHECK ("status" IN ('active','pending','superseded','deleted')),
  CONSTRAINT "user_memory_provenance_check" CHECK ("provenance" IN ('manual','background_review')),
  CONSTRAINT "user_memory_confidence_check" CHECK ("confidence" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "user_memory_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "memory_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "action" varchar NOT NULL,
  "snapshot" json NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "user_memory_event_action_check" CHECK ("action" IN ('create','update','supersede','delete','restore'))
);
--> statement-breakpoint
ALTER TABLE "chat_message_search" ADD CONSTRAINT "chat_message_search_message_id_chat_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_message"("id") ON DELETE cascade;
ALTER TABLE "chat_message_search" ADD CONSTRAINT "chat_message_search_thread_id_chat_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_thread"("id") ON DELETE cascade;
ALTER TABLE "chat_message_search" ADD CONSTRAINT "chat_message_search_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_source_thread_id_chat_thread_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "public"."chat_thread"("id") ON DELETE SET NULL;
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_source_message_id_chat_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."chat_message"("id") ON DELETE SET NULL;
ALTER TABLE "user_memory_event" ADD CONSTRAINT "user_memory_event_memory_id_user_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."user_memory"("id") ON DELETE cascade;
ALTER TABLE "user_memory_event" ADD CONSTRAINT "user_memory_event_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "chat_message_search_user_idx" ON "chat_message_search" USING btree ("user_id");
CREATE INDEX "chat_message_search_fts_idx" ON "chat_message_search" USING gin (to_tsvector('simple', "content"));
CREATE INDEX "chat_message_search_trgm_idx" ON "chat_message_search" USING gin ("content" gin_trgm_ops);
CREATE INDEX "user_memory_user_status_idx" ON "user_memory" USING btree ("user_id", "status");
CREATE INDEX "user_memory_content_trgm_idx" ON "user_memory" USING gin ("content" gin_trgm_ops);
CREATE INDEX "user_memory_event_memory_idx" ON "user_memory_event" USING btree ("memory_id");
