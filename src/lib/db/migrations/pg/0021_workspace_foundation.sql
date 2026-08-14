CREATE TABLE "workspace" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "name" varchar(120) NOT NULL,
  "slug" varchar(80) NOT NULL,
  "description" text,
  "instructions" text,
  "status" varchar DEFAULT 'active' NOT NULL,
  "default_model_id" uuid,
  "default_agent_id" uuid,
  "default_tool_mode" varchar DEFAULT 'auto' NOT NULL,
  "metadata" json,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "workspace_status_check" CHECK ("status" IN ('active','archived')),
  CONSTRAINT "workspace_tool_mode_check" CHECK ("default_tool_mode" IN ('auto','manual','none'))
);
--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_default_model_id_model_configuration_id_fk" FOREIGN KEY ("default_model_id") REFERENCES "public"."model_configuration"("id") ON DELETE SET NULL;
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_default_agent_id_agent_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agent"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_user_slug_unique" ON "workspace" USING btree ("user_id", "slug");
CREATE INDEX "workspace_user_status_idx" ON "workspace" USING btree ("user_id", "status");
--> statement-breakpoint
ALTER TABLE "chat_thread" ADD COLUMN "workspace_id" uuid;
ALTER TABLE "chat_thread" ADD CONSTRAINT "chat_thread_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE SET NULL;
CREATE INDEX "chat_thread_workspace_idx" ON "chat_thread" USING btree ("workspace_id");
