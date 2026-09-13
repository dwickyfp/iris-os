-- Workspace files: scoped virtual filesystem for agent file operations.
--
-- Content is bounded UTF-8 text stored inline (application-enforced limit
-- 512 KiB); large or binary payloads remain with the artifact subsystem.
-- Scoping mirrors AgentRuntimeContext: scope_key is 'task:<id>',
-- 'workspace:<id>', or 'global'; workspace_id/task_id carry the FK cascade.
-- Uniqueness of (user_id, scope_key, path) makes one file per scope path;
-- version enables optimistic concurrency for write/edit/move.
CREATE TABLE "workspace_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"scope_key" varchar(120) NOT NULL,
	"workspace_id" uuid,
	"task_id" uuid,
	"path" text NOT NULL,
	"filename" varchar(240) NOT NULL,
	"media_type" varchar(160) NOT NULL,
	"content" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_file" ADD CONSTRAINT "workspace_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_file" ADD CONSTRAINT "workspace_file_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_file" ADD CONSTRAINT "workspace_file_task_id_iris_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."iris_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_file" ADD CONSTRAINT "workspace_file_size_check" CHECK ("workspace_file"."size" >= 0);--> statement-breakpoint
ALTER TABLE "workspace_file" ADD CONSTRAINT "workspace_file_version_check" CHECK ("workspace_file"."version" >= 1);--> statement-breakpoint
ALTER TABLE "workspace_file" ADD CONSTRAINT "workspace_file_scope_key_check" CHECK ("workspace_file"."scope_key" <> '');--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_file_scope_path_unique" ON "workspace_file" USING btree ("user_id","scope_key","path");--> statement-breakpoint
CREATE INDEX "workspace_file_scope_prefix_idx" ON "workspace_file" USING btree ("user_id","scope_key","path");--> statement-breakpoint
CREATE INDEX "workspace_file_user_updated_idx" ON "workspace_file" USING btree ("user_id","updated_at");
