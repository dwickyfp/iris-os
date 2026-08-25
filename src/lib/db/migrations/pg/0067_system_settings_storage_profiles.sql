CREATE TABLE "file_storage_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"driver" varchar(24) NOT NULL,
	"endpoint" text,
	"region" varchar(120),
	"bucket" varchar(240),
	"encrypted_access_key" text,
	"encrypted_secret_key" text,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"public_base_url" text,
	"prefix" varchar(256) DEFAULT 'uploads' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"retired_at" timestamp,
	CONSTRAINT "file_storage_profile_driver_check" CHECK ("file_storage_profile"."driver" IN ('vercel-blob','s3','minio')),
	CONSTRAINT "file_storage_profile_version_check" CHECK ("file_storage_profile"."version" > 0),
	CONSTRAINT "file_storage_profile_credentials_check" CHECK (("file_storage_profile"."encrypted_access_key" IS NULL) = ("file_storage_profile"."encrypted_secret_key" IS NULL)),
	CONSTRAINT "file_storage_profile_s3_check" CHECK ("file_storage_profile"."driver" = 'vercel-blob' OR ("file_storage_profile"."region" IS NOT NULL AND "file_storage_profile"."bucket" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "file_storage_setting" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"active_profile_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "file_storage_setting_singleton_check" CHECK ("file_storage_setting"."singleton"),
	CONSTRAINT "file_storage_setting_version_check" CHECK ("file_storage_setting"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "system_setting_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(128) NOT NULL,
	"operation" varchar(16) NOT NULL,
	"value_kind" varchar(16) NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "system_setting_audit_operation_check" CHECK ("system_setting_audit"."operation" IN ('set','clear')),
	CONSTRAINT "system_setting_audit_value_kind_check" CHECK ("system_setting_audit"."value_kind" IN ('plain','secret')),
	CONSTRAINT "system_setting_audit_revision_check" CHECK ("system_setting_audit"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "system_setting" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"value_kind" varchar(16) NOT NULL,
	"value" json,
	"encrypted_value" text,
	"encryption_key_id" varchar(64),
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"rotated_at" timestamp,
	CONSTRAINT "system_setting_value_kind_check" CHECK ("system_setting"."value_kind" IN ('plain','secret')),
	CONSTRAINT "system_setting_revision_check" CHECK ("system_setting"."revision" > 0),
	CONSTRAINT "system_setting_value_check" CHECK (("system_setting"."value_kind" = 'plain' AND "system_setting"."encrypted_value" IS NULL AND "system_setting"."encryption_key_id" IS NULL) OR ("system_setting"."value_kind" = 'secret' AND "system_setting"."value" IS NULL AND "system_setting"."encrypted_value" IS NOT NULL AND "system_setting"."encryption_key_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "artifact_cleanup" ADD COLUMN "storage_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "storage_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "file_storage_setting" ADD CONSTRAINT "file_storage_setting_active_profile_id_file_storage_profile_id_fk" FOREIGN KEY ("active_profile_id") REFERENCES "public"."file_storage_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "system_setting_audit_key_created_idx" ON "system_setting_audit" USING btree ("key","created_at");--> statement-breakpoint
CREATE INDEX "system_setting_audit_actor_created_idx" ON "system_setting_audit" USING btree ("actor_id","created_at");--> statement-breakpoint
ALTER TABLE "artifact_cleanup" ADD CONSTRAINT "artifact_cleanup_storage_profile_id_file_storage_profile_id_fk" FOREIGN KEY ("storage_profile_id") REFERENCES "public"."file_storage_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_storage_profile_id_file_storage_profile_id_fk" FOREIGN KEY ("storage_profile_id") REFERENCES "public"."file_storage_profile"("id") ON DELETE restrict ON UPDATE no action;
