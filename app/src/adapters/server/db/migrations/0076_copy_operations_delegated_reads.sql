-- story.5004 / task.1791070959 — delegated SELECT for copy-operations reads,
-- plus the two keyset indexes the new capabilities order by.
--
-- ===========================================================================
-- SCOPE NOTE, because the obvious guess is wrong twice over.
-- ===========================================================================
--
-- 1. `poly_copy_trade_config` IS NOT TOUCHED, because it DOES NOT EXIST.
--    Migration 0036 is the single line `DROP TABLE "poly_copy_trade_config"
--    CASCADE;` and neither schema package references it. There is no config
--    table and no per-tenant kill switch (NO_KILL_SWITCH, bug.0438). Effective
--    sizing policy is DERIVED from the target row; the caps live on
--    `poly_wallet_grants`. Any instruction to add a policy to the config table
--    is obsolete.
--
-- 2. `poly_copy_trade_{fills,decisions,targets}` ARE NOT TOUCHED, because
--    migration 0074 already gave all three a grant-aware delegated SELECT
--    policy (owner OR an active `account:read`/`performance:read` grant). The
--    only table in this capability's join that still lacks a delegated read is
--    `poly_wallet_grants`.
--
-- ===========================================================================
-- THE GAP THIS CLOSES
-- ===========================================================================
--
-- `poly_wallet_grants` carries the wallet safety caps (`per_order_usdc_cap`,
-- `daily_usdc_cap`, `hourly_fills_cap`). Since migration 0031 it has had
-- exactly ONE policy, `tenant_isolation`, created with no `FOR` clause — so it
-- is `FOR ALL`, and both its USING and WITH CHECK admit only the
-- billing-account OWNER. The table also carries FORCE ROW LEVEL SECURITY and is
-- owned by the app role.
--
-- The consequence is the specific failure mode migration 0074's header warns
-- about: a delegated principal holding a valid `account:read` grant passes
-- `authorize()` and then reads ZERO rows here. Because RLS filters rather than
-- raises, the caps do not error — they SILENTLY VANISH, and the capability would
-- report "no caps on file" for an account that is fully configured. Under
-- NO_FABRICATED_VALUES that is the worst available outcome, since "no caps"
-- reads as "no limits".
--
-- ===========================================================================
-- WHY THIS IS ADDITIVE AND WHY WRITES STAY OWNER-ONLY
-- ===========================================================================
--
-- `tenant_isolation` is deliberately LEFT IN PLACE and is NOT dropped or
-- rewritten. The new policy is PERMISSIVE and `FOR SELECT` only.
--
--   * PostgreSQL ORs permissive policies within a command. For SELECT the
--     applicable set becomes {tenant_isolation, ..._delegated_select}: the owner
--     still reads via either, and a delegate reads via the new one.
--   * For INSERT / UPDATE / DELETE the applicable set is UNCHANGED — a
--     `FOR SELECT` policy contributes no USING to an UPDATE/DELETE row check and
--     no WITH CHECK to an INSERT. So mutation authority remains exactly
--     `tenant_isolation`, i.e. the billing-account owner. A delegate's UPDATE
--     finds zero updatable rows and fails closed.
--
-- This is why the pair does NOT need the drop-then-create dance 0074 required:
-- nothing is being replaced, so there is no policy-less window. CREATE POLICY on
-- a FORCE-RLS table can only ADD visibility here, never remove it.
--
-- The policy body is copied from the 0074 form ON PURPOSE, including the
-- `scopes && ARRAY['account:read','performance:read']` OVERLAP (not containment)
-- so a grant holding EITHER name reads rows throughout the expand phase, and
-- including the `billing_account_id IN (SELECT id FROM billing_accounts WHERE
-- owner_user_id = current_setting(...))` owner form. That owner form matters:
-- 0070/0073/0074 moved the copy-trade policies OFF `created_by_user_id` and onto
-- the billing-account owner. `poly_wallet_grants` keeps `created_by_user_id` as
-- audit metadata only (see 0031), so matching on it here would be wrong.
--
-- Caps remain CEILINGS, NOT TARGETS (0031). Exposing them read-only grants no
-- mutation authority and no signing authority whatsoever.
--
-- NOT exposed, deliberately: `poly_wallet_connections` keeps its owner-only
-- policy untouched. It holds AEAD-encrypted CLOB credentials, and a delegated
-- analytical read has no business there. Eligibility is derived from grants
-- alone, leaning on REVOKE_CASCADES_FROM_CONNECTION (0031).

CREATE POLICY "poly_wallet_grants_delegated_select" ON "poly_wallet_grants"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_wallet_grants"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
    )
  );--> statement-breakpoint

-- ===========================================================================
-- KEYSET INDEXES FOR THE TWO NEW READS
-- ===========================================================================
--
-- The attempt tape orders by `(decided_at DESC, id DESC)` filtered on one
-- account, and pages with the row-value predicate
-- `(d.decided_at, d.id) < ($cutoff, $id)`.
--
-- No existing index serves that. The closest,
-- `poly_copy_trade_decisions_investigation_idx`, leads with
-- `(billing_account_id, (intent->>'market_id'), mode, decided_at DESC, id DESC)`
-- — the account-wide tape does NOT filter on market, so that index's second
-- column breaks the prefix and Postgres would fall back to scanning the
-- account's decisions and sorting them. `_decided_at_idx` is account-blind and
-- `_billing_account_idx` gives no ordering.
--
-- This index makes both the ORDER BY and the keyset predicate index-only
-- prefix work: equality on `billing_account_id`, then a descending range scan
-- that stops after LIMIT+1 rows regardless of how many decisions the account
-- has accumulated. It is the difference between a bounded page read and a
-- full-account sort.
CREATE INDEX IF NOT EXISTS "poly_copy_trade_decisions_account_tape_idx"
  ON "poly_copy_trade_decisions" ("billing_account_id", "decided_at" DESC, "id" DESC);--> statement-breakpoint

-- The inverted orders read is account-wide and ordered
-- `(observed_at DESC, target_id DESC, fill_id DESC)`.
-- `poly_copy_trade_fills_investigation_idx` leads with
-- `(billing_account_id, market_id, mode, observed_at DESC, ...)`, so — same
-- problem — the account-wide read cannot use it as a prefix once `market_id` is
-- unconstrained. The tie-breaker columns match the ORDER BY exactly so the sort
-- is fully satisfied by the index.
CREATE INDEX IF NOT EXISTS "poly_copy_trade_fills_account_recent_idx"
  ON "poly_copy_trade_fills" ("billing_account_id", "observed_at" DESC, "target_id" DESC, "fill_id" DESC);
