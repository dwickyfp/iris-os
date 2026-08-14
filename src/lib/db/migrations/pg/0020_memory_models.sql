ALTER TABLE "model_configuration" ADD COLUMN "model_kind" varchar DEFAULT 'chat' NOT NULL;
ALTER TABLE "model_configuration" ADD COLUMN "is_curator" boolean DEFAULT false NOT NULL;
ALTER TABLE "model_configuration" ADD COLUMN "is_embedding_default" boolean DEFAULT false NOT NULL;
ALTER TABLE "model_configuration" ADD COLUMN "embedding_dimensions" integer;
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_kind_check" CHECK ("model_kind" IN ('chat','embedding'));
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_embedding_dimensions_check" CHECK ("embedding_dimensions" IS NULL OR "embedding_dimensions" > 0);
CREATE UNIQUE INDEX "model_configuration_one_curator_idx" ON "model_configuration" ("is_curator") WHERE "is_curator" = true;
CREATE UNIQUE INDEX "model_configuration_one_embedding_default_idx" ON "model_configuration" ("is_embedding_default") WHERE "is_embedding_default" = true;
