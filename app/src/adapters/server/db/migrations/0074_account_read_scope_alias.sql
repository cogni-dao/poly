-- story.5006 / task.1791070961 — rename the delegated account-read scope
-- `performance:read` -> `account:read`, EXPAND phase.
--
-- Why one migration: the app-side CHECK widening and the three delegated SELECT
-- policy bodies MUST land together. If the CHECK were widened while the policies
-- still required `performance:read`, a grant holding only the new alias would
-- pass authorize() and then read ZERO rows through RLS — presenting as "no data"
-- rather than "denied". That is the worst failure available here, so the CHECK
-- comes first and every policy body is rewritten immediately after it.
--
-- Why OVERLAP (&&) and not containment (@>): both names must satisfy both the
-- app check and RLS for the whole expand phase. `scopes && ARRAY[...]` is true
-- when the grant holds EITHER name, so the one grant already issued in
-- production (stored as `performance:read`) keeps reading with no human
-- re-approval, and newly minted `account:read` grants read immediately.
--
-- Rows are NOT backfilled and `performance:read` is NOT dropped. Both are a
-- later contract-phase task.
--
-- Atomicity: drizzle's migrator runs every statement of one migration file
-- inside a single transaction, and each DROP POLICY below is immediately
-- followed by its CREATE POLICY. poly_copy_trade_{fills,decisions,targets} all
-- carry FORCE ROW LEVEL SECURITY and are owned by the app role, so a policy-less
-- window would be a total read outage for app-role — never separate a pair.

ALTER TABLE "agent_capability_grants" DROP CONSTRAINT IF EXISTS "agent_capability_grants_scopes_canonical";--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_scopes_canonical" CHECK ("agent_capability_grants"."scopes" <@ ARRAY['account:read','performance:read','research:run','policy:propose','paper:assign','live:approve','live:assign']::text[]);--> statement-breakpoint

DROP POLICY IF EXISTS "poly_copy_trade_fills_select" ON "poly_copy_trade_fills";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_fills_select" ON "poly_copy_trade_fills"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_copy_trade_fills"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS "poly_copy_trade_decisions_select" ON "poly_copy_trade_decisions";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_decisions_select" ON "poly_copy_trade_decisions"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_copy_trade_decisions"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS "poly_copy_trade_targets_select" ON "poly_copy_trade_targets";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_targets_select" ON "poly_copy_trade_targets"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_copy_trade_targets"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
    )
  );
