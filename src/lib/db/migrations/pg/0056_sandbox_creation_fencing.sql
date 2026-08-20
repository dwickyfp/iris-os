ALTER TABLE "sandbox_session" ADD COLUMN "creator_token" uuid;
--> statement-breakpoint
ALTER TABLE "sandbox_session" DROP CONSTRAINT "sandbox_session_status_check";
--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_status_check"
  CHECK ("status" IN ('creating','active','destroying','destroyed','cancelled','failed'));
