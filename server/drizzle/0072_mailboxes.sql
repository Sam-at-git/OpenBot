CREATE TABLE "mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"security" text DEFAULT 'ssl' NOT NULL,
	"username" text NOT NULL,
	"encrypted_password" text NOT NULL,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 15 NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"last_new_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_interval_check" CHECK ("mailboxes"."interval_minutes" >= 5 AND "mailboxes"."interval_minutes" <= 1440),
	CONSTRAINT "mailboxes_security_check" CHECK ("mailboxes"."security" IN ('ssl', 'starttls', 'plain')),
	CONSTRAINT "mailboxes_status_check" CHECK ("mailboxes"."last_status" IN ('idle', 'running', 'succeeded', 'error'))
);
--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_owner_agent_idx" ON "mailboxes" USING btree ("owner_user_id","agent_id");--> statement-breakpoint
CREATE INDEX "mailboxes_due_idx" ON "mailboxes" USING btree ("enabled","next_run_at");