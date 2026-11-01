CREATE TABLE "computer_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT '*' NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computer_secrets" ADD CONSTRAINT "computer_secrets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computer_secrets_name_scope_key" ON "computer_secrets" USING btree ("name","scope");