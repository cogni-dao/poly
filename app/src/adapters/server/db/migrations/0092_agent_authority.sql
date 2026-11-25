CREATE TABLE "agent_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"slug" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principals_kind_canonical" CHECK ("agent_principals"."kind" IN ('internal','external')),
	CONSTRAINT "agent_principals_internal_has_slug" CHECK ("agent_principals"."kind" <> 'internal' OR "agent_principals"."slug" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"principal_user_id" text NOT NULL,
	"scope" text NOT NULL,
	"approved_by" text,
	"granted_at" timestamp with time zone,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"resource" text DEFAULT 'node' NOT NULL,
	"account_id" text,
	"expires_at" timestamp with time zone,
	"link_hash" text,
	"link_expires_at" timestamp with time zone,
	"link_consumed_at" timestamp with time zone,
	CONSTRAINT "agent_roles_resource_canonical" CHECK ("agent_roles"."resource" IN ('node','account')),
	CONSTRAINT "agent_roles_node_shape" CHECK ("agent_roles"."resource" <> 'node' OR ("agent_roles"."account_id" IS NULL AND "agent_roles"."expires_at" IS NULL)),
	CONSTRAINT "agent_roles_account_live_shape" CHECK ("agent_roles"."resource" <> 'account' OR "agent_roles"."approved_by" IS NULL OR ("agent_roles"."account_id" IS NOT NULL AND "agent_roles"."granted_at" IS NOT NULL AND ("agent_roles"."expires_at" IS NULL OR "agent_roles"."expires_at" > "agent_roles"."granted_at"))),
	CONSTRAINT "agent_roles_no_self_approval" CHECK ("agent_roles"."approved_by" IS NULL OR "agent_roles"."approved_by" <> "agent_roles"."principal_user_id"),
	CONSTRAINT "agent_roles_link_consumed_has_no_hash" CHECK ("agent_roles"."link_consumed_at" IS NULL OR "agent_roles"."link_hash" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" ADD CONSTRAINT "agent_principals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_principal_user_id_users_id_fk" FOREIGN KEY ("principal_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_account_id_billing_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_slug_unique" ON "agent_principals" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_principals_user_id_unique" ON "agent_principals" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_live_unique" ON "agent_roles" USING btree ("principal_user_id","scope") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_roles_principal_idx" ON "agent_roles" USING btree ("principal_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_link_hash_unique" ON "agent_roles" USING btree ("link_hash");--> statement-breakpoint
CREATE POLICY "agent_principals_read" ON "agent_principals" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "agent_roles_account_self_read" ON "agent_roles" AS PERMISSIVE FOR SELECT TO public USING ("agent_roles"."resource" = 'account' AND "agent_roles"."principal_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
-- story.0090: canonical internal AI identity (node-ai). Seeds identity only; never a capability.
-- Seeded before FORCE RLS (agent_principals admits SELECT only), like 0008's system tenant.
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0001', true);
--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address")
VALUES ('00000000-0000-4000-a000-0000000a0001', 'node-ai', NULL) ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = '00000000-0000-4000-a000-0000000a0001'
    AND name = 'node-ai' AND wallet_address IS NULL AND email IS NULL) THEN
    RAISE EXCEPTION 'canonical node-ai identity collision';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id")
VALUES ('internal', 'node-ai', '00000000-0000-4000-a000-0000000a0001') ON CONFLICT ("user_id") DO NOTHING;
--> statement-breakpoint
SELECT set_config('app.current_user_id', '', true);
--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;
