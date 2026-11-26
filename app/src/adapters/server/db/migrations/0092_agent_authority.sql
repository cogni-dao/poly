-- Poly 0092: the shared agent authority tables (`@cogni-dao/agent-grants/schema`) and the seed of the two internal principals (story.0090).
-- Provenance: Poly has no earlier agent_principals / agent_roles table (verified: no migration 0000-0091 names either), so this is plain generated DDL
-- plus the package SQL tail `migrations/agent_authority.sql` (agent-grants 0.10.0), appended verbatim. No existing row is adopted, altered or deleted.
-- Poly's own account-grant plane (`agent_capability_grants`) is untouched; it retires in a later migration with its own review.
CREATE TABLE "agent_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"slug" text,
	"owner_source_kind" text,
	"owner_source_ref" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_principals_kind_canonical" CHECK ("agent_principals"."kind" IN ('internal','external','org')),
	CONSTRAINT "agent_principals_org_has_owner_source" CHECK ("agent_principals"."kind" <> 'org' OR ("agent_principals"."owner_source_kind" IS NOT NULL AND "agent_principals"."owner_source_ref" IS NOT NULL)),
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
CREATE UNIQUE INDEX "agent_principals_org_source_unique" ON "agent_principals" USING btree ("owner_source_kind","owner_source_ref") WHERE "agent_principals"."kind" = 'org';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_live_unique" ON "agent_roles" USING btree ("principal_user_id","scope") WHERE "agent_roles"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_link_hash_unique" ON "agent_roles" USING btree ("link_hash");--> statement-breakpoint
CREATE INDEX "agent_roles_principal_idx" ON "agent_roles" USING btree ("principal_user_id");--> statement-breakpoint
CREATE POLICY "agent_principals_read" ON "agent_principals" AS PERMISSIVE FOR SELECT TO public USING (true);--> statement-breakpoint
CREATE POLICY "agent_roles_account_self_read" ON "agent_roles" AS PERMISSIVE FOR SELECT TO public USING ("agent_roles"."resource" = 'account' AND "agent_roles"."principal_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
-- agent_authority: the SQL TAIL for `agent_principals` and `agent_roles`, plus the seed of the node's two internal principals (node-template 0036 + 0037 + 0038).
-- The table part is NOT here: `defineAgentAuthoritySchema` (`@cogni-dao/agent-grants/schema`) owns it, and the node's own `db:generate` writes it, with the
-- account and org columns, their CHECKs and the two select policies. Append this file after that generated SQL. See README.md; never copy a snapshot.
-- FORCE RLS and the seed are outside Drizzle's DDL scope.
-- agent_roles has NO policy: ENABLE + FORCE = deny-all for the app role. Only a connection that bypasses row-level security reads or writes it
-- (the guard, the role routes). agent_principals is readable by all roles, writable only by that connection.
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Seed (idempotent): each internal principal is a `users` row with NO wallet and NO credential, plus an `agent_principals` row of kind 'internal'.
-- Ids and slugs match `INTERNAL_AGENT_PRINCIPALS` in `@cogni-dao/agent-grants`. No role rows are seeded: a node-admin turns each role On.
-- `users` has FORCE RLS (self_isolation): set the RLS context to each principal before its insert (transaction-local).
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0001', true);--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address") VALUES ('00000000-0000-4000-a000-0000000a0001', 'node-ai', NULL) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
SELECT set_config('app.current_user_id', '00000000-0000-4000-a000-0000000a0002', true);--> statement-breakpoint
INSERT INTO "users" ("id", "name", "wallet_address") VALUES ('00000000-0000-4000-a000-0000000a0002', 'prioritizer', NULL) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- agent_principals is FORCE RLS with a select-only policy, so even its owner cannot INSERT: lift FORCE for the seed only, inside the migration transaction.
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id") VALUES ('internal', 'node-ai', '00000000-0000-4000-a000-0000000a0001') ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "slug", "user_id") VALUES ('internal', 'prioritizer', '00000000-0000-4000-a000-0000000a0002') ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
