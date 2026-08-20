ALTER TABLE "artifact" ADD COLUMN "output_execution_id" uuid;
--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "output_relative_path" varchar(1024);
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_output_provenance_pair_check" CHECK (("output_execution_id" IS NULL) = ("output_relative_path" IS NULL));
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_output_relative_path_check" CHECK ("output_relative_path" IS NULL OR ("output_relative_path" <> '' AND "output_relative_path" !~ '(^|/)\.\.(/|$)' AND "output_relative_path" !~ '^/' AND "output_relative_path" !~ E'\\\\'));
--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_output_provenance_unique" ON "artifact" USING btree ("output_execution_id","output_relative_path","sha256") WHERE "output_execution_id" IS NOT NULL;
