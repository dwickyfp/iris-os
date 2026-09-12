-- Memory hot-path: exact-duplicate detection and chat-history recall.
--
-- user_memory.content_hash backs the reviewer's exact-claim dedup: previously
-- findExactActiveClaim loaded up to 500 rows per scope and normalized each in
-- Node on every add. The hash is sha256 of lib/ai/memory/curator.ts
-- normalizeMemoryText(content); the backfill expression below was verified to
-- produce byte-identical hashes with the Node implementation on a
-- mixed-script corpus (NFKC, id-ID lowercase, quote-char strip, punctuation
-- mapping, whitespace collapse) on PostgreSQL >= 13.
--
-- chat_message_search had no FTS index, so every cross-thread recall
-- `content @@ websearch_to_tsquery(...)` was a sequential scan.
ALTER TABLE "user_memory" ADD COLUMN IF NOT EXISTS "content_hash"
  varchar(64) NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE "user_memory" SET "content_hash" = encode(
  sha256(
    convert_to(
      btrim(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(normalize("content", NFKC)),
              '[' || chr(8220) || chr(8221) || '"''`' || ']', '', 'g'
            ),
            '[^[:alpha:][:digit:][:space:]]', ' ', 'g'
          ),
          '\s+', ' ', 'g'
        )
      ),
      'UTF8'
    )
  ),
  'hex'
)
WHERE "content_hash" = '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_memory_scope_hash_idx"
  ON "user_memory" ("user_id", "scope_type", "scope_id", "content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_search_content_fts_idx"
  ON "chat_message_search" USING gin (to_tsvector('simple', "content"));
