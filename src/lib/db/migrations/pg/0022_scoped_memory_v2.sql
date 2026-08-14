ALTER TABLE "user_memory" DROP CONSTRAINT IF EXISTS "user_memory_kind_check";
UPDATE "user_memory" SET "kind" = 'semantic' WHERE "kind" = 'fact';
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_kind_check" CHECK ("kind" IN ('identity','preference','semantic','episodic','decision','procedure','operational','relationship','goal'));
--> statement-breakpoint
ALTER TABLE "user_memory" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "user_memory" ADD COLUMN "scope_id" uuid;
ALTER TABLE "user_memory" ADD COLUMN "importance" integer DEFAULT 50 NOT NULL;
ALTER TABLE "user_memory" ADD COLUMN "frequency" integer DEFAULT 1 NOT NULL;
ALTER TABLE "user_memory" ADD COLUMN "stability" integer DEFAULT 50 NOT NULL;
ALTER TABLE "user_memory" ADD COLUMN "payload" json DEFAULT '{}'::json NOT NULL;
ALTER TABLE "user_memory" ADD COLUMN "valid_from" timestamp;
ALTER TABLE "user_memory" ADD COLUMN "valid_to" timestamp;
ALTER TABLE "user_memory" ADD COLUMN "observed_at" timestamp;
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_scope_check" CHECK (("scope_type" = 'global' AND "scope_id" IS NULL) OR ("scope_type" IN ('workspace','task','agent') AND "scope_id" IS NOT NULL));
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_importance_check" CHECK ("importance" BETWEEN 0 AND 100);
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_stability_check" CHECK ("stability" BETWEEN 0 AND 100);
ALTER TABLE "user_memory" ADD CONSTRAINT "user_memory_frequency_check" CHECK ("frequency" >= 1);
--> statement-breakpoint
ALTER TABLE "memory_topic" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "memory_topic" ADD COLUMN "scope_id" uuid;
ALTER TABLE "memory_entity" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "memory_entity" ADD COLUMN "scope_id" uuid;
ALTER TABLE "memory_edge" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "memory_edge" ADD COLUMN "scope_id" uuid;
ALTER TABLE "memory_evidence" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "memory_evidence" ADD COLUMN "scope_id" uuid;
ALTER TABLE "memory_embedding" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "memory_embedding" ADD COLUMN "scope_id" uuid;
ALTER TABLE "memory_curator_run" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "memory_curator_run" ADD COLUMN "scope_id" uuid;
ALTER TABLE "memory_retrieval_audit" ADD COLUMN "scope_type" varchar DEFAULT 'global' NOT NULL;
ALTER TABLE "memory_retrieval_audit" ADD COLUMN "scope_id" uuid;
--> statement-breakpoint
ALTER TABLE "memory_topic" DROP CONSTRAINT IF EXISTS "memory_topic_user_id_normalized_key_unique";
ALTER TABLE "memory_entity" DROP CONSTRAINT IF EXISTS "memory_entity_user_id_normalized_key_unique";
ALTER TABLE "memory_edge" DROP CONSTRAINT IF EXISTS "memory_edge_user_id_source_id_target_id_type_unique";
ALTER TABLE "memory_embedding" DROP CONSTRAINT IF EXISTS "memory_embedding_user_id_node_id_model_unique";
CREATE UNIQUE INDEX "memory_topic_exact_scope_key_uidx" ON "memory_topic" ("user_id", "scope_type", "scope_id", "normalized_key") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "memory_entity_exact_scope_key_uidx" ON "memory_entity" ("user_id", "scope_type", "scope_id", "normalized_key") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "memory_edge_exact_scope_uidx" ON "memory_edge" ("user_id", "scope_type", "scope_id", "source_id", "target_id", "type") NULLS NOT DISTINCT;
CREATE UNIQUE INDEX "memory_embedding_exact_scope_uidx" ON "memory_embedding" ("user_id", "scope_type", "scope_id", "node_id", "model") NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX "user_memory_user_scope_status_idx" ON "user_memory" ("user_id", "scope_type", "scope_id", "status");
CREATE INDEX "memory_topic_user_scope_status_idx" ON "memory_topic" ("user_id", "scope_type", "scope_id", "status");
CREATE INDEX "memory_entity_user_scope_status_idx" ON "memory_entity" ("user_id", "scope_type", "scope_id", "status");
CREATE INDEX "memory_edge_user_scope_idx" ON "memory_edge" ("user_id", "scope_type", "scope_id");
CREATE INDEX "memory_embedding_user_scope_idx" ON "memory_embedding" ("user_id", "scope_type", "scope_id");
