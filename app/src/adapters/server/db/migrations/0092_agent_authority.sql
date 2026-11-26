-- Poly 0092: the shared agent authority tables (`@cogni-dao/agent-grants/schema`) and the seed of the two internal principals (story.0090).
-- APPROVED: CEO (Derek) 2026-11-27: purge the #314 leftovers, forward-looking only.
-- Provenance, corrected: Poly's JOURNAL (migrations 0000-0091) names no agent_principals / agent_roles, but the candidate-a and preview databases hold
-- the leftovers of the reverted poly#314 (story.5158, "adopt agent-grants 0.5.0"): its migrations 0092_agent_identity (sha256 039ff5ba..),
-- 0093_agent_spawn_grants (e30cb9c2..) and 0094_agent_personal_grants (f9aeaaa0..) were applied on 11-13 (Loki COGNI_MIGRATION_RECEIPT_V1 shows them as
-- `unknown:*` entries, declared 92 / applied 97) and #314 was reverted by #317 (9bbc85b28), which never removed them. Evidence for the purge:
--   * current main reads none of the five tables (git grep of the names and the Drizzle identifiers: no hit outside migrations and docs);
--   * no other table, policy or view references them (their foreign keys point only from agent_* to users); the one outside hook is the trigger on
--     user_bindings, which this step drops;
--   * production holds none of them (a read of the production Poly datasource: `relation "agent_credentials" does not exist`).
-- The step below runs ONLY when that exact #314 shape is present (agent_roles.resource_kind exists, agent_principals.owner_source_kind is absent, and both #314
-- triggers exist). Production and fresh databases fall through to the plain DDL unchanged; any other shape keeps failing loudly on CREATE TABLE.
-- It drops exactly: the triggers agent_principals_no_wallet_binding (user_bindings) and agent_credentials_external_principal_only; the function
-- agent_credential_state(agent_credentials); the tables agent_claims, agent_spawn_grants, agent_credentials, agent_roles, agent_principals; and the trigger functions
-- agent_principals_refuse_wallet_binding() and agent_credentials_require_external_principal(). No CASCADE: an unexpected dependent aborts the whole migration.
-- It deletes no other row. The seeded `users` rows node-ai and prioritizer stay: the package seed below reuses the same IDs and upserts (ON CONFLICT DO NOTHING).
-- Then the generated DDL for the package tables is created exactly as on a fresh database, plus the package SQL tail `migrations/agent_authority.sql` (agent-grants 0.10.0), appended verbatim.
-- Poly's own account-grant plane (`agent_capability_grants` and the 11 delegated policies that read it) is untouched; it retires in a later migration with its own review.
-- Deliberately NOT here (each joins in the PR that needs it, with its own conformance run):
--   * the package tail `agent_account_grants.sql` (the `agent_has_scope()` function and the CURRENT_USER select grant): the account columns and the
--     `agent_roles_account_self_read` policy come with the generated DDL but stay inert until the grant-plane retirement writes Poly's delegated select policies;
--   * `agent_credentials` and its tail `agent_credentials.sql`, `payer_bindings`, orgs and service-auth: this PR adds no credential route, so
--     `runCredentialConformance` has nothing to run against; the credentials PR takes that tail and that suite together;
--   * the AGENT_WALLET_IS_NOT_A_PAYEE trigger and principal backfill (node-template 0043, 0044): they change tables Poly owns and are written with the grant-plane PR.
-- Gate: app/tests/component/db/agent-authority-migration.int.test.ts (app-role wall, service-role privileges, seed idempotence, legacy plane unchanged, runGrantConformance,
-- and the #314 purge applied on top of the real #314 files).
DO $poly314$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_roles' AND column_name = 'resource_kind')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_principals' AND column_name = 'owner_source_kind')
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_principals_no_wallet_binding' AND tgrelid = to_regclass('public.user_bindings') AND NOT tgisinternal)
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_credentials_external_principal_only' AND tgrelid = to_regclass('public.agent_credentials') AND NOT tgisinternal)
  THEN
    DROP TRIGGER "agent_principals_no_wallet_binding" ON "public"."user_bindings";
    DROP TRIGGER "agent_credentials_external_principal_only" ON "public"."agent_credentials";
    DROP FUNCTION "public"."agent_credential_state"("public"."agent_credentials");
    DROP TABLE "public"."agent_claims";
    DROP TABLE "public"."agent_spawn_grants";
    DROP TABLE "public"."agent_credentials";
    DROP TABLE "public"."agent_roles";
    DROP TABLE "public"."agent_principals";
    DROP FUNCTION "public"."agent_principals_refuse_wallet_binding"();
    DROP FUNCTION "public"."agent_credentials_require_external_principal"();
  END IF;
END
$poly314$;--> statement-breakpoint
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
