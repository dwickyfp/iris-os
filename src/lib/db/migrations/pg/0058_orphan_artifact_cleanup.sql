ALTER TABLE "artifact_cleanup" DROP CONSTRAINT "artifact_cleanup_artifact_id_fkey";
--> statement-breakpoint
ALTER TABLE "artifact_cleanup" DROP CONSTRAINT "artifact_cleanup_pkey";
--> statement-breakpoint
ALTER TABLE "artifact_cleanup" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifact_cleanup" ALTER COLUMN "artifact_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "artifact_cleanup" ADD CONSTRAINT "artifact_cleanup_pkey" PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE "artifact_cleanup" ADD CONSTRAINT "artifact_cleanup_artifact_id_fkey"
  FOREIGN KEY ("artifact_id") REFERENCES "artifact"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "artifact_cleanup" ADD CONSTRAINT "artifact_cleanup_artifact_unique" UNIQUE ("artifact_id");
