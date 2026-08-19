-- Full-text search indexes for keyword-only and lexical hybrid memory recall.
-- websearch_to_tsquery with the 'simple' dictionary keeps Indonesian and mixed
-- language recall deterministic; GIN keeps the @@ filter index-only.

CREATE INDEX "user_memory_content_fts_idx"
  ON "user_memory" USING GIN (to_tsvector('simple', "content"));
--> statement-breakpoint
CREATE INDEX "chat_message_search_content_fts_idx"
  ON "chat_message_search" USING GIN (to_tsvector('simple', "content"));
