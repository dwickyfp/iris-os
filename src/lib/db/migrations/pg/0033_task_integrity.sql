UPDATE "iris_task" SET "started_at" = COALESCE("started_at", "updated_at")
  WHERE "status" IN ('in_progress','blocked','completed');
UPDATE "iris_task" SET "blocked_at" = COALESCE("blocked_at", "updated_at")
  WHERE "status" = 'blocked';
UPDATE "iris_task" SET "completed_at" = COALESCE("completed_at", "updated_at")
  WHERE "status" = 'completed';
UPDATE "iris_task" SET "cancelled_at" = COALESCE("cancelled_at", "updated_at")
  WHERE "status" = 'cancelled';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION iris_task_enforce_integrity() RETURNS trigger AS $$
DECLARE
  parent_row iris_task%ROWTYPE;
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent WHERE id = NEW.assigned_agent_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'assigned agent must be owned by task user' USING ERRCODE = '23514';
  END IF;

  IF NEW.parent_task_id IS NOT NULL THEN
    IF NEW.parent_task_id = NEW.id THEN
      RAISE EXCEPTION 'task cannot be its own parent' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO parent_row FROM iris_task WHERE id = NEW.parent_task_id;
    IF NOT FOUND OR parent_row.user_id <> NEW.user_id OR
       parent_row.workspace_id IS DISTINCT FROM NEW.workspace_id THEN
      RAISE EXCEPTION 'parent task must share owner and workspace' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (
      WITH RECURSIVE ancestors AS (
        SELECT id, parent_task_id FROM iris_task WHERE id = NEW.parent_task_id
        UNION ALL
        SELECT task.id, task.parent_task_id FROM iris_task task
        JOIN ancestors a ON task.id = a.parent_task_id
      )
      SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
      RAISE EXCEPTION 'task parent cycle is not allowed' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'planned' AND NEW.status IN ('in_progress','cancelled')) OR
      (OLD.status = 'in_progress' AND NEW.status IN ('blocked','completed','cancelled')) OR
      (OLD.status = 'blocked' AND NEW.status IN ('in_progress','cancelled'))
    ) THEN
      RAISE EXCEPTION 'invalid task status transition' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.status = 'in_progress' THEN
    NEW.started_at := COALESCE(NEW.started_at, CURRENT_TIMESTAMP);
    NEW.blocked_at := NULL;
  ELSIF NEW.status = 'blocked' THEN
    NEW.started_at := COALESCE(NEW.started_at, CURRENT_TIMESTAMP);
    NEW.blocked_at := COALESCE(NEW.blocked_at, CURRENT_TIMESTAMP);
  ELSIF NEW.status = 'completed' THEN
    NEW.started_at := COALESCE(NEW.started_at, CURRENT_TIMESTAMP);
    NEW.completed_at := COALESCE(NEW.completed_at, CURRENT_TIMESTAMP);
  ELSIF NEW.status = 'cancelled' THEN
    NEW.cancelled_at := COALESCE(NEW.cancelled_at, CURRENT_TIMESTAMP);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER iris_task_integrity_trigger
  BEFORE INSERT OR UPDATE ON iris_task
  FOR EACH ROW EXECUTE FUNCTION iris_task_enforce_integrity();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION task_resource_ref_enforce_owner() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM iris_task WHERE id = NEW.task_id AND user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'resource and task ownership must match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER task_resource_ref_owner_trigger
  BEFORE INSERT OR UPDATE ON task_resource_ref
  FOR EACH ROW EXECUTE FUNCTION task_resource_ref_enforce_owner();
--> statement-breakpoint
ALTER TABLE "iris_task" ADD CONSTRAINT "iris_task_terminal_timestamp_check" CHECK (
  ("status" <> 'in_progress' OR "started_at" IS NOT NULL) AND
  ("status" <> 'blocked' OR ("started_at" IS NOT NULL AND "blocked_at" IS NOT NULL)) AND
  ("status" <> 'completed' OR "completed_at" IS NOT NULL) AND
  ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL)
);
