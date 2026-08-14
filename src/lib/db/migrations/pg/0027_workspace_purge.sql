CREATE TABLE "workspace_deletion_tombstone" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id_hash" varchar(64) NOT NULL,
  "user_id_hash" varchar(64) NOT NULL,
  "sanitized_counts" json DEFAULT '{}'::json NOT NULL,
  "deleted_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX "workspace_tombstone_hash_idx" ON "workspace_deletion_tombstone" ("workspace_id_hash");
