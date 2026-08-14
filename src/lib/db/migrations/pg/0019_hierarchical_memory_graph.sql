DO $$ BEGIN
  BEGIN CREATE EXTENSION IF NOT EXISTS vector;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector unavailable; memory retrieval will use lexical fallback';
  END;
END $$;
--> statement-breakpoint
CREATE TABLE "memory_topic" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "label" varchar(160) NOT NULL, "normalized_key" varchar(180) NOT NULL,
  "summary" varchar(600) DEFAULT '' NOT NULL, "detail" varchar(4000) DEFAULT '' NOT NULL,
  "confidence" integer DEFAULT 80 NOT NULL CHECK ("confidence" BETWEEN 0 AND 100),
  "status" varchar DEFAULT 'active' NOT NULL CHECK ("status" IN ('active','pending','superseded','deleted')),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE("user_id", "normalized_key")
);
--> statement-breakpoint
CREATE TABLE "memory_entity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "name" varchar(240) NOT NULL, "normalized_key" varchar(260) NOT NULL,
  "entity_type" varchar(64) DEFAULT 'concept' NOT NULL, "aliases" json DEFAULT '[]'::json NOT NULL,
  "confidence" integer DEFAULT 80 NOT NULL CHECK ("confidence" BETWEEN 0 AND 100),
  "status" varchar DEFAULT 'active' NOT NULL CHECK ("status" IN ('active','pending','superseded','deleted')),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE("user_id", "normalized_key")
);
--> statement-breakpoint
CREATE TABLE "memory_edge" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "source_id" uuid NOT NULL, "source_type" varchar NOT NULL CHECK ("source_type" IN ('topic','claim','entity')),
  "target_id" uuid NOT NULL, "target_type" varchar NOT NULL CHECK ("target_type" IN ('topic','claim','entity')),
  "type" varchar NOT NULL CHECK ("type" IN ('ABOUT','SUPPORTS','REFINES','RELATED_TO','CONTRADICTS','SUPERSEDES')),
  "weight" integer DEFAULT 100 NOT NULL CHECK ("weight" BETWEEN 0 AND 100),
  "confidence" integer DEFAULT 80 NOT NULL CHECK ("confidence" BETWEEN 0 AND 100),
  "provenance" varchar DEFAULT 'background_review' NOT NULL CHECK ("provenance" IN ('manual','background_review')),
  "reason" text, "valid_from" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, "valid_to" timestamp,
  "status" varchar DEFAULT 'active' NOT NULL CHECK ("status" IN ('active','pending','superseded','deleted')),
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE("user_id", "source_id", "target_id", "type")
);
--> statement-breakpoint
CREATE TABLE "memory_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "memory_id" uuid REFERENCES "user_memory"("id") ON DELETE cascade,
  "topic_id" uuid REFERENCES "memory_topic"("id") ON DELETE cascade,
  "thread_id" uuid REFERENCES "chat_thread"("id") ON DELETE SET NULL,
  "message_id" text REFERENCES "chat_message"("id") ON DELETE SET NULL,
  "excerpt" text NOT NULL, "content_hash" varchar(64) NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CHECK ("memory_id" IS NOT NULL OR "topic_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "memory_embedding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "node_id" uuid NOT NULL, "node_type" varchar NOT NULL CHECK ("node_type" IN ('topic','claim','entity')),
  "model" varchar(180) NOT NULL, "dimensions" integer NOT NULL, "values" json NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE("user_id", "node_id", "model")
);
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE memory_embedding ADD COLUMN IF NOT EXISTS vector_value vector;
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "memory_curator_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "job_type" varchar NOT NULL CHECK ("job_type" IN ('extract','curate','sweep','reembed')),
  "status" varchar NOT NULL CHECK ("status" IN ('running','completed','failed')),
  "stats" json DEFAULT '{}'::json NOT NULL, "error" text, "rollback_snapshot" json,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL, "completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "memory_retrieval_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "query_hash" varchar(64) NOT NULL, "seed_nodes" json DEFAULT '[]'::json NOT NULL,
  "traversal_paths" json DEFAULT '[]'::json NOT NULL, "final_nodes" json DEFAULT '[]'::json NOT NULL,
  "ranking" json DEFAULT '{}'::json NOT NULL, "token_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX "memory_topic_user_status_idx" ON "memory_topic"("user_id", "status");
CREATE INDEX "memory_topic_trgm_idx" ON "memory_topic" USING gin (("label" || ' ' || "summary" || ' ' || "detail") gin_trgm_ops);
CREATE INDEX "memory_entity_user_status_idx" ON "memory_entity"("user_id", "status");
CREATE INDEX "memory_entity_trgm_idx" ON "memory_entity" USING gin ("name" gin_trgm_ops);
CREATE INDEX "memory_edge_user_source_idx" ON "memory_edge"("user_id", "source_id");
CREATE INDEX "memory_edge_user_target_idx" ON "memory_edge"("user_id", "target_id");
CREATE INDEX "memory_evidence_user_memory_idx" ON "memory_evidence"("user_id", "memory_id");
CREATE INDEX "memory_evidence_user_topic_idx" ON "memory_evidence"("user_id", "topic_id");
CREATE INDEX "memory_embedding_user_idx" ON "memory_embedding"("user_id");
CREATE INDEX "memory_curator_run_user_idx" ON "memory_curator_run"("user_id", "created_at" DESC);
CREATE INDEX "memory_retrieval_audit_user_idx" ON "memory_retrieval_audit"("user_id", "created_at" DESC);
--> statement-breakpoint
INSERT INTO "memory_topic" ("user_id", "label", "normalized_key", "summary", "detail", "confidence")
SELECT "user_id", CASE "kind" WHEN 'preference' THEN 'Preferensi' WHEN 'goal' THEN 'Tujuan' ELSE 'Tentang pengguna' END,
  "kind", left(string_agg("content", '; ' ORDER BY "updated_at" DESC), 600),
  left(string_agg("content", E'\n' ORDER BY "updated_at" DESC), 4000), round(avg("confidence"))::integer
FROM "user_memory" WHERE "status" = 'active' AND "deleted_at" IS NULL GROUP BY "user_id", "kind"
ON CONFLICT ("user_id", "normalized_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "memory_edge" ("user_id", "source_id", "source_type", "target_id", "target_type", "type", "confidence", "provenance")
SELECT m."user_id", m."id", 'claim', t."id", 'topic', 'ABOUT', m."confidence", m."provenance"
FROM "user_memory" m JOIN "memory_topic" t ON t."user_id" = m."user_id" AND t."normalized_key" = m."kind"
WHERE m."status" = 'active' AND m."deleted_at" IS NULL ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "memory_evidence" ("user_id", "memory_id", "thread_id", "message_id", "excerpt", "content_hash")
SELECT "user_id", "id", "source_thread_id", "source_message_id", "content", md5("content")
FROM "user_memory" WHERE "source_thread_id" IS NOT NULL OR "source_message_id" IS NOT NULL;
