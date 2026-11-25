-- story.0090: the rest of node-template's identity model, extending 0092 (0092 is never edited).
-- credentials (revocable hashed agent keys), payer bindings, one-wallet-one-key and the payout guard. Orgs are not part of this node.
-- Table DDL below is drizzle-generated; the data steps, FORCE RLS, functions and triggers are hand-written (outside drizzle's DDL scope).

-- ONE_WALLET_ONE_KEY: a wallet is keyed by its lowercase address. Normalize existing wallet bindings before the unique index exists.
-- user_bindings has FORCE RLS (tenant_isolation) and the migrating role sees no tenant, so lift FORCE for this step only (precedent: 0037); it runs inside
-- the migration transaction, so no other session sees it.
ALTER TABLE "user_bindings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- NO_AUTO_MERGE: two owners of one wallet that differ only in case are never merged silently. Fail loudly and list the colliding rows.
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(format('%s => binding ids/users: %s', key, owners), '; ')
    INTO collisions
  FROM (
    SELECT lower(external_id) AS key,
           string_agg(id || ' (user ' || user_id || ', ' || external_id || ')', ', ') AS owners
    FROM "user_bindings"
    WHERE provider = 'wallet'
    GROUP BY lower(external_id)
    HAVING count(*) > 1
  ) c;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'wallet bindings collide after lowercasing; resolve by hand, no owner is merged automatically: %', collisions;
  END IF;
END
$$;--> statement-breakpoint
UPDATE "user_bindings" SET external_id = lower(external_id) WHERE provider = 'wallet' AND external_id <> lower(external_id);--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_from" text NOT NULL,
	"predecessor_id" uuid,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renew_until" timestamp with time zone NOT NULL,
	"pending_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"revoked_by" text,
	CONSTRAINT "agent_credentials_created_from_canonical" CHECK ("agent_credentials"."created_from" IN ('spawn_grant','rotation','key_upgrade','binding_recovery','recovery_grant')),
	CONSTRAINT "agent_credentials_renew_after_expiry" CHECK ("agent_credentials"."renew_until" > "agent_credentials"."expires_at")
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payer_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_user_id" text NOT NULL,
	"billing_account_id" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payer_bindings_no_self_approval" CHECK ("payer_bindings"."approved_by" IS NULL OR "payer_bindings"."approved_by" <> "payer_bindings"."subject_user_id"),
	CONSTRAINT "payer_bindings_approval_is_paired" CHECK (("payer_bindings"."approved_by" IS NULL) = ("payer_bindings"."approved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "payer_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "link_transactions" DROP CONSTRAINT "link_transactions_provider_check";--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_predecessor_id_fk" FOREIGN KEY ("predecessor_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payer_bindings" ADD CONSTRAINT "payer_bindings_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_token_hash_unique" ON "agent_credentials" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_one_pending_successor" ON "agent_credentials" USING btree ("predecessor_id") WHERE "agent_credentials"."confirmed_at" IS NULL AND "agent_credentials"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_credentials_user_idx" ON "agent_credentials" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payer_bindings_open_per_subject" ON "payer_bindings" USING btree ("subject_user_id") WHERE "payer_bindings"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payer_bindings_account_idx" ON "payer_bindings" USING btree ("billing_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_bindings_wallet_lower_unique" ON "user_bindings" USING btree ("provider",lower("external_id")) WHERE "user_bindings"."provider" = 'wallet';--> statement-breakpoint
ALTER TABLE "link_transactions" ADD CONSTRAINT "link_transactions_provider_check" CHECK ("link_transactions"."provider" IN ('github', 'discord', 'google', 'wallet'));
--> statement-breakpoint
-- payer_bindings has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "payer_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Hand-written below: FORCE RLS, a function and a trigger are outside Drizzle's DDL scope (same as 0027 / 0031 / 0036).
-- agent_credentials has NO policy: ENABLE + FORCE = deny-all for the app role. Only the BYPASSRLS service role reads or writes it.
ALTER TABLE "agent_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- STATE_IS_DERIVED: the one derivation of a credential's state from its timestamps, against the DATABASE clock. Never stored.
CREATE OR REPLACE FUNCTION agent_credential_state(c agent_credentials)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN c.revoked_at IS NOT NULL THEN 'revoked'
    WHEN c.confirmed_at IS NULL THEN CASE WHEN c.pending_expires_at > now() THEN 'pending' ELSE 'pending_expired' END
    WHEN c.expires_at > now() THEN 'active'
    WHEN c.renew_until > now() THEN 'renew_only'
    ELSE 'expired'
  END
$$;--> statement-breakpoint
-- CREDENTIALS_ONLY_ON_AGENT_PRINCIPALS: a credential may belong only to a user with an EXTERNAL agent_principals row. An internal
-- principal (this node's AI) never holds a key, and a plain user has no agent row until `upgrade` writes one.
CREATE OR REPLACE FUNCTION agent_credentials_require_external_principal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM agent_principals ap WHERE ap.user_id = NEW.user_id AND ap.kind = 'external') THEN
    RAISE EXCEPTION 'agent credential for % requires an external agent principal', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_credentials_external_principal_only';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_credentials_external_principal_only" ON "agent_credentials";--> statement-breakpoint
CREATE TRIGGER "agent_credentials_external_principal_only"
  BEFORE INSERT OR UPDATE OF user_id ON "agent_credentials"
  FOR EACH ROW EXECUTE FUNCTION agent_credentials_require_external_principal();

--> statement-breakpoint
-- AGENT_WALLET_IS_NOT_A_PAYEE: an agent principal may bind a wallet (it is how an AI becomes an admin the DAO lists), so no payout leaf may resolve to an agent-owned wallet.
-- The function is NOT security definer: leaf rows are written by the BYPASSRLS service role, so the invoker sees users and user_bindings in full.
CREATE OR REPLACE FUNCTION agent_wallet_is_not_a_payee()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_principals ap
    WHERE ap.user_id IN (
      SELECT b.user_id FROM user_bindings b
      WHERE b.provider = 'wallet' AND lower(b.external_id) = lower(NEW.account_lower)
      UNION
      SELECT u.id FROM users u WHERE lower(u.wallet_address) = lower(NEW.account_lower)
    )
  ) THEN
    RAISE EXCEPTION 'wallet % belongs to an agent principal and cannot be a payee', NEW.account_lower
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_wallet_is_not_a_payee';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "epoch_distribution_leaves_agent_wallet_is_not_a_payee"
  BEFORE INSERT ON "epoch_distribution_leaves"
  FOR EACH ROW EXECUTE FUNCTION agent_wallet_is_not_a_payee();--> statement-breakpoint
CREATE TRIGGER "distribution_settlement_leaves_agent_wallet_is_not_a_payee"
  BEFORE INSERT ON "distribution_settlement_leaves"
  FOR EACH ROW EXECUTE FUNCTION agent_wallet_is_not_a_payee();

--> statement-breakpoint
-- Backfill (task.0144): every outside agent registered before registration wrote its principal row gets an external `agent_principals` row,
-- so kind is read from one place. Data only, idempotent (ON CONFLICT DO NOTHING; a rerun inserts nothing).
-- PRECISION OVER COVERAGE: an agent row stops payouts to that user's wallet (0043, AGENT_WALLET_IS_NOT_A_PAYEE), so a human misread as an agent
-- loses pay. A missed agent is only a missing label, so the rule is deliberately narrow: it picks a user only when NO trace of a human path exists.
-- The v1 key is a signed token that is not stored, so the only durable trace of an agent registration is the user it created: no wallet, no
-- binding, no profile, no identity event. Every human creation path (SIWE: auth.ts:231; OAuth first login: auth.ts:548; operator-attested
-- GitHub sign-in: operator-attested-binding.server.ts:131) sets users.wallet_address or writes a `user_bindings` row with the user (SIWE also
-- writes one), and also writes a `user_profiles` row; the two non-SIWE paths write an `identity_events` row too. The seeded system tenant is
-- excluded by id; the internal principals (0037) already have rows. A user that already has a row (internal or external) keeps it.
-- users, user_bindings, user_profiles and identity_events have FORCE RLS keyed to a session user, and agent_principals is select-only for every
-- role, so a migration run as the table owner would see no rows (every NOT EXISTS would then be true). Lift FORCE for this statement only,
-- inside the migration transaction (same as 0037 and 0038), and restore it after.
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "agent_principals" ("kind", "user_id")
SELECT 'external', u."id"
FROM "users" u
WHERE u."wallet_address" IS NULL
  AND u."id" <> '00000000-0000-4000-a000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM "user_bindings" b WHERE b."user_id" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "user_profiles" p WHERE p."user_id" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "identity_events" e WHERE e."user_id" = u."id")
ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
