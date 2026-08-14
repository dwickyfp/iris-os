ALTER TABLE "skill" DROP CONSTRAINT IF EXISTS "skill_provenance_check";
ALTER TABLE "skill" ADD CONSTRAINT "skill_provenance_check" CHECK ("provenance" IN ('manual','background_review','generated','learned'));
ALTER TABLE "skill" ADD COLUMN "source_candidate_id" uuid REFERENCES "learning_candidate"("id") ON DELETE SET NULL;
ALTER TABLE "skill" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
CREATE INDEX "skill_source_candidate_idx" ON "skill" ("source_candidate_id");
--> statement-breakpoint
COMMENT ON COLUMN "skill"."version" IS 'Repeated corrections create a new reviewed version; learned skills are never silently rewritten';
