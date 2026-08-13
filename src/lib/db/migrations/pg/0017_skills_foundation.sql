CREATE TABLE "agent_skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "agent_skill_agent_id_skill_id_unique" UNIQUE("agent_id","skill_id"),
	CONSTRAINT "agent_skill_agent_id_position_unique" UNIQUE("agent_id","position"),
	CONSTRAINT "agent_skill_position_check" CHECK ("agent_skill"."position" between 0 and 19)
);
--> statement-breakpoint
CREATE TABLE "skill_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "skill_file_skill_id_path_unique" UNIQUE("skill_id","path"),
	CONSTRAINT "skill_file_size_check" CHECK ("skill_file"."size" between 0 and 10485760)
);
--> statement-breakpoint
CREATE TABLE "skill" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icon" json,
	"license" text,
	"compatibility" text,
	"metadata" json,
	"allowed_tools" json,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"visibility" varchar DEFAULT 'private' NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"archived_at" timestamp,
	CONSTRAINT "skill_user_id_name_unique" UNIQUE("user_id","name"),
	CONSTRAINT "skill_name_check" CHECK ("skill"."name" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length("skill"."name") between 1 and 64),
	CONSTRAINT "skill_description_check" CHECK (char_length("skill"."description") between 1 and 1024),
	CONSTRAINT "skill_body_size_check" CHECK (octet_length("skill"."body") between 1 and 102400),
	CONSTRAINT "skill_visibility_check" CHECK ("skill"."visibility" in ('private', 'readonly'))
);
--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skill" ADD CONSTRAINT "agent_skill_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_file" ADD CONSTRAINT "skill_file_skill_id_skill_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skill"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill" ADD CONSTRAINT "skill_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skill_agent_id_idx" ON "agent_skill" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_skill_skill_id_idx" ON "agent_skill" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_file_skill_id_idx" ON "skill_file" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX "skill_user_id_idx" ON "skill" USING btree ("user_id");
