-- Skills: allow "public" visibility.
--
-- Semantics: public skills are readable and assignable by every user, but only
-- the owner can edit or archive them (mutation routes stay owner-only). This
-- mirrors the discovery model of readonly sharing while making intent explicit
-- in the UI; the read paths treat "readonly" and "public" identically.
ALTER TABLE "skill" DROP CONSTRAINT "skill_visibility_check";--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_visibility_check"
  CHECK ("skill"."visibility" in ('private', 'readonly', 'public'));
