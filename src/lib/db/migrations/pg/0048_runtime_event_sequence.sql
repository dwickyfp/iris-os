CREATE TABLE "iris_activity_run_sequence" (
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "run_id" varchar(160) NOT NULL,
  "last_sequence" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("user_id", "run_id")
);
--> statement-breakpoint
ALTER TABLE "iris_activity_event" ADD COLUMN "occurrence_id" uuid;
ALTER TABLE "iris_activity_event" ADD COLUMN "sequence" integer;
ALTER TABLE "iris_activity_event" ADD COLUMN "trajectory_id" varchar(160);
UPDATE "iris_activity_event"
SET "occurrence_id" = "id",
    "trajectory_id" = coalesce("parent_run_id", "run_id")
WHERE "run_id" IS NOT NULL;
WITH ordered AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "user_id", "trajectory_id"
    ORDER BY "created_at", "id"
  ) AS "sequence"
  FROM "iris_activity_event"
  WHERE "run_id" IS NOT NULL
)
UPDATE "iris_activity_event" AS event
SET "sequence" = ordered."sequence"
FROM ordered
WHERE event."id" = ordered."id";
INSERT INTO "iris_activity_run_sequence" ("user_id", "run_id", "last_sequence")
SELECT "user_id", "trajectory_id", max("sequence")
FROM "iris_activity_event"
WHERE "run_id" IS NOT NULL
GROUP BY "user_id", "trajectory_id";
ALTER TABLE "iris_activity_event" ADD CONSTRAINT "iris_activity_occurrence_id_unique" UNIQUE("occurrence_id");
ALTER TABLE "iris_activity_event" ADD CONSTRAINT "iris_activity_run_sequence_unique" UNIQUE("user_id", "trajectory_id", "sequence");
ALTER TABLE "iris_activity_event" ADD CONSTRAINT "iris_activity_sequence_check" CHECK ("sequence" IS NULL OR "sequence" > 0);
--> statement-breakpoint
CREATE FUNCTION allocate_iris_activity_run_sequence() RETURNS trigger AS $$
BEGIN
  IF NEW.run_id IS NOT NULL AND NEW.sequence IS NULL THEN
    NEW.trajectory_id := coalesce(NEW.parent_run_id, NEW.run_id);
    INSERT INTO iris_activity_run_sequence (user_id, run_id, last_sequence)
    VALUES (NEW.user_id, NEW.trajectory_id, 1)
    ON CONFLICT (user_id, run_id) DO UPDATE
      SET last_sequence = iris_activity_run_sequence.last_sequence + 1
    RETURNING last_sequence INTO NEW.sequence;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER iris_activity_allocate_run_sequence
BEFORE INSERT ON "iris_activity_event"
FOR EACH ROW EXECUTE FUNCTION allocate_iris_activity_run_sequence();
--> statement-breakpoint
CREATE INDEX "iris_activity_run_sequence_idx" ON "iris_activity_event" ("user_id", "trajectory_id", "sequence");
