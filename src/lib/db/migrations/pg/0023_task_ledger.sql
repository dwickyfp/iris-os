CREATE TABLE "iris_task" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "workspace_id" uuid REFERENCES "workspace"("id") ON DELETE SET NULL,
  "parent_task_id" uuid,
  "assigned_agent_id" uuid REFERENCES "agent"("id") ON DELETE SET NULL,
  "title" varchar(240) NOT NULL,
  "description" text,
  "status" varchar DEFAULT 'planned' NOT NULL CHECK ("status" IN ('planned','in_progress','blocked','completed','cancelled')),
  "priority" varchar DEFAULT 'normal' NOT NULL CHECK ("priority" IN ('low','normal','high','urgent')),
  "next_action" text,
  "checkpoint" text,
  "due_at" timestamp,
  "started_at" timestamp,
  "blocked_at" timestamp,
  "completed_at" timestamp,
  "cancelled_at" timestamp,
  "metadata" json DEFAULT '{}'::json NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
ALTER TABLE "iris_task" ADD CONSTRAINT "iris_task_parent_fk" FOREIGN KEY ("parent_task_id") REFERENCES "iris_task"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE TABLE "task_activity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "iris_task"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "type" varchar(80) NOT NULL,
  "payload" json DEFAULT '{}'::json NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE "task_resource_ref" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "iris_task"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "kind" varchar NOT NULL CHECK ("kind" IN ('thread','file','artifact','workflow_run','tool_run','repository','url','decision')),
  "reference_id" text NOT NULL,
  "label" varchar(240),
  "metadata" json DEFAULT '{}'::json NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE ("task_id", "kind", "reference_id")
);
--> statement-breakpoint
ALTER TABLE "chat_thread" ADD COLUMN "task_id" uuid REFERENCES "iris_task"("id") ON DELETE SET NULL;
CREATE INDEX "iris_task_user_status_idx" ON "iris_task" ("user_id", "status");
CREATE INDEX "iris_task_workspace_status_idx" ON "iris_task" ("workspace_id", "status");
CREATE INDEX "task_activity_task_idx" ON "task_activity" ("task_id", "created_at" DESC);
CREATE INDEX "task_resource_ref_task_idx" ON "task_resource_ref" ("task_id");
CREATE INDEX "chat_thread_task_idx" ON "chat_thread" ("task_id");
