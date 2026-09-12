-- Hot-path indexes: chat_message previously had no index on thread_id, so
-- every thread load, sidebar join, and cascade delete was a sequential scan.
CREATE INDEX IF NOT EXISTS "chat_message_thread_created_idx"
  ON "chat_message" ("thread_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_message_search_thread_idx"
  ON "chat_message_search" ("thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iris_activity_thread_idx"
  ON "iris_activity_event" ("thread_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "iris_activity_task_idx"
  ON "iris_activity_event" ("task_id");
