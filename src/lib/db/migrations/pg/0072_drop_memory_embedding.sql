-- Memory embedding removal: memory recall is lexical + graph only, so the
-- vector store, its model bookkeeping, and the embedding engine assignment
-- are retired. Lexical quality/performance replaces it:
--   - GIN index on the 'simple' tsvector of user_memory.content accelerates
--     the hot `@@ to_tsquery` recall predicate (previously a sequential scan).
--   - pg_trgm adds a fuzzy net for typos and unstemmed morphological variants,
--     also index-accelerated.
DROP TABLE IF EXISTS "memory_embedding";
--> statement-breakpoint
DELETE FROM "model_engine_assignment" WHERE "engine_key" = 'memory-embedding';
--> statement-breakpoint
ALTER TABLE "model_configuration" DROP COLUMN IF EXISTS "is_embedding_default";
--> statement-breakpoint
ALTER TABLE "model_configuration" DROP COLUMN IF EXISTS "embedding_dimensions";
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_content_fts_idx"
  ON "user_memory" USING gin (to_tsvector('simple', "content"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_content_trgm_idx"
  ON "user_memory" USING gin ("content" gin_trgm_ops);
