CREATE TABLE "uploaded_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"storage_profile_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"source_url" text NOT NULL,
	"filename" varchar(240) NOT NULL,
	"media_type" varchar(160) NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "uploaded_file_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "uploaded_file_size_check" CHECK ("uploaded_file"."size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "uploaded_file" ADD CONSTRAINT "uploaded_file_storage_profile_id_file_storage_profile_id_fk" FOREIGN KEY ("storage_profile_id") REFERENCES "public"."file_storage_profile"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploaded_file" ADD CONSTRAINT "uploaded_file_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "uploaded_file_user_created_idx" ON "uploaded_file" USING btree ("user_id","created_at");
