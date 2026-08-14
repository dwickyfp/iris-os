CREATE TABLE "model_engine_assignment" (
  "engine_key" varchar(64) PRIMARY KEY NOT NULL,
  "model_id" uuid NOT NULL REFERENCES "model_configuration"("id") ON DELETE CASCADE,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "model_engine_assignment_key_check" CHECK (
    "engine_key" IN (
      'memory-curator',
      'context-summary',
      'thread-title',
      'automation-runner',
      'delegation-runner',
      'memory-embedding'
    )
  )
);
--> statement-breakpoint
CREATE INDEX "model_engine_assignment_model_idx"
  ON "model_engine_assignment" ("model_id");
--> statement-breakpoint
INSERT INTO "model_engine_assignment" ("engine_key", "model_id")
SELECT 'memory-curator', "id"
FROM "model_configuration"
WHERE "is_curator" = true
ORDER BY "updated_at" DESC
LIMIT 1
ON CONFLICT ("engine_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "model_engine_assignment" ("engine_key", "model_id")
SELECT 'memory-embedding', "id"
FROM "model_configuration"
WHERE "is_embedding_default" = true
ORDER BY "updated_at" DESC
LIMIT 1
ON CONFLICT ("engine_key") DO NOTHING;
