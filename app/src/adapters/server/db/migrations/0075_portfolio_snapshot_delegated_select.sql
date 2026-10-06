-- story.5004 / task.1791070962 — delegated SELECT for the portfolio snapshot.
--
-- WHY THIS EXISTS
-- Migration 0074 gave poly_copy_trade_{fills,decisions,targets} a delegated
-- SELECT policy, so an approved agent can read the copy-trade ledger. But the
-- coherent portfolio snapshot also reads two tables that only ever had an
-- OWNER policy: poly_wallet_connections (wallet identity + readiness) and
-- poly_wallet_balance_snapshots (cash + gas). Both carry ENABLE + FORCE ROW
-- LEVEL SECURITY, so without this migration a correctly-granted agent would
-- pass authorize() and then read ZERO rows from those two tables.
--
-- That failure is worse than a denial, which is exactly the trap 0074's header
-- calls out: the snapshot would resolve no wallet address, fall through to
-- `emptyDashboard(...)`, and return HTTP 200 with `connected: false` and null
-- balances. An agent would see a well-formed, authoritative-looking snapshot
-- of a wallet that does in fact exist and does in fact hold money. Returning
-- "nothing" where "something" is true is the fabrication class this whole
-- story was opened to eliminate, so the policy and the capability must land in
-- lockstep.
--
-- WHY ADD-ONLY, NOT DROP-AND-RECREATE
-- 0070 and 0073 replaced `tenant_isolation` with four named policies
-- (_select/_insert/_update/_delete). This migration deliberately does NOT do
-- that. Permissive policies combine with OR, and the existing
-- `tenant_isolation` policies are FOR ALL — so adding a second FOR SELECT
-- policy widens reads to `owner OR valid grant` while leaving the write path
-- governed by the untouched `tenant_isolation` body. Consequences:
--
--   * WRITES STAY OWNER-ONLY, by construction rather than by re-derivation.
--     The new policies are FOR SELECT, so they can never authorize an INSERT,
--     UPDATE or DELETE. No write policy body is rewritten, so no write path can
--     regress — and `poly_wallet_connections` writes are the wallet
--     provisioning path, which is not somewhere to take risk for tidiness.
--   * No policy-less window. A drop/recreate pair on a FORCE RLS table is a
--     total read outage for the app role if anything goes wrong between them.
--   * No drizzle snapshot drift. `poly_wallet_balance_snapshots` declares
--     `pgPolicy("tenant_isolation")` + `.enableRLS()` in
--     packages/db-schema/src/wallet-connections.ts; dropping that policy in SQL
--     while leaving the TS declaration in place would make the next
--     `drizzle-kit generate` try to recreate it. Leaving it alone keeps the TS
--     declaration truthful.
--
-- SCOPE MATCHING — must stay identical to authorize() and to 0074
-- `scopes && ARRAY['account:read','performance:read']` is OVERLAP, not
-- containment. `account:read` is canonical and `performance:read` is its
-- retained legacy alias (story.5006 expand phase), and `aliasesFor()` in
-- app/src/features/agent-grants/authorization.ts matches the same two names the
-- same way. If these ever disagree, the symptom is "authorized but no data",
-- so the two must be changed together.
--
-- NOT COVERED HERE, DELIBERATELY: the snapshot also reads poly_trader_* ,
-- poly_market_outcomes, poly_market_metadata and poly_redeem_jobs, which have
-- NO row-level security at all — no ENABLE, no FORCE, no policy, in any
-- migration or either schema package. That is the documented RLS_BACKSTOP
-- carve-out (docs/spec/capability-plane.md, Carve-out 1): for those tables the
-- capability is the ONLY tenant clamp, and the account filter in the read model
-- is load-bearing security rather than a correctness detail. Granting them RLS
-- is a separate, larger change (they are keyed by wallet address, not by
-- billing account, so it needs a mapping) and is out of scope here.
--
-- Atomicity: drizzle's migrator runs every statement of one migration file in a
-- single transaction, and these are pure additive CREATE POLICY statements
-- guarded by DROP ... IF EXISTS so the migration is idempotent on re-apply.

DROP POLICY IF EXISTS "poly_wallet_connections_delegated_select" ON "poly_wallet_connections";--> statement-breakpoint
CREATE POLICY "poly_wallet_connections_delegated_select" ON "poly_wallet_connections"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_wallet_connections"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS "poly_wallet_balance_snapshots_delegated_select" ON "poly_wallet_balance_snapshots";--> statement-breakpoint
CREATE POLICY "poly_wallet_balance_snapshots_delegated_select" ON "poly_wallet_balance_snapshots"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_wallet_balance_snapshots"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
    )
  );
