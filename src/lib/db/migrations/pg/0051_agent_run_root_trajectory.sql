ALTER TABLE "agent_run" ADD COLUMN "root_run_id" uuid;
--> statement-breakpoint
WITH RECURSIVE ancestry AS (
  SELECT id, id AS root_run_id
  FROM "agent_run"
  WHERE parent_run_id IS NULL
  UNION ALL
  SELECT child.id, ancestry.root_run_id
  FROM "agent_run" child
  JOIN ancestry ON ancestry.id = child.parent_run_id
)
UPDATE "agent_run" AS run
SET root_run_id = ancestry.root_run_id
FROM ancestry
WHERE run.id = ancestry.id;
--> statement-breakpoint
ALTER TABLE "agent_run"
  ALTER COLUMN "root_run_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_run"
  ADD CONSTRAINT "agent_run_root_run_fk"
  FOREIGN KEY ("root_run_id") REFERENCES "agent_run"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "agent_run_root_idx" ON "agent_run" ("root_run_id");
--> statement-breakpoint
ALTER TABLE "iris_activity_event"
  DROP CONSTRAINT IF EXISTS "iris_activity_run_sequence_unique";
--> statement-breakpoint
UPDATE "iris_activity_event" AS event
SET trajectory_id = run.root_run_id::text
FROM "agent_run" AS run
WHERE event.run_id = run.id::text;
--> statement-breakpoint
TRUNCATE TABLE "iris_activity_run_sequence";
--> statement-breakpoint
WITH ordered AS (
  SELECT id, row_number() OVER (
    PARTITION BY user_id, trajectory_id
    ORDER BY created_at, id
  ) AS sequence
  FROM iris_activity_event
  WHERE run_id IS NOT NULL AND trajectory_id IS NOT NULL
)
UPDATE iris_activity_event AS event
SET sequence = ordered.sequence
FROM ordered
WHERE event.id = ordered.id;
--> statement-breakpoint
INSERT INTO iris_activity_run_sequence (user_id, run_id, last_sequence)
SELECT user_id, trajectory_id, max(sequence)
FROM iris_activity_event
WHERE trajectory_id IS NOT NULL
GROUP BY user_id, trajectory_id;
--> statement-breakpoint
ALTER TABLE "iris_activity_event"
  ADD CONSTRAINT "iris_activity_run_sequence_unique"
  UNIQUE(user_id, trajectory_id, sequence);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION allocate_iris_activity_run_sequence() RETURNS trigger AS $$
BEGIN
  IF NEW.run_id IS NOT NULL AND NEW.sequence IS NULL THEN
    SELECT root_run_id::text INTO NEW.trajectory_id
    FROM agent_run
    WHERE id::text = NEW.run_id;
    NEW.trajectory_id := coalesce(NEW.trajectory_id, NEW.parent_run_id, NEW.run_id);
    INSERT INTO iris_activity_run_sequence (user_id, run_id, last_sequence)
    VALUES (NEW.user_id, NEW.trajectory_id, 1)
    ON CONFLICT (user_id, run_id) DO UPDATE
      SET last_sequence = iris_activity_run_sequence.last_sequence + 1
    RETURNING last_sequence INTO NEW.sequence;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
