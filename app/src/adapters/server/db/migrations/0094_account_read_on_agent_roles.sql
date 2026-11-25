-- story.0090: account-read delegation moves onto the one grant table (`agent_roles`, resource = 'account'), EXPAND phase.
-- One door asks (/api/v1/agent/access-requests), the account owner decides on /profile (/api/v1/agent-access/mine), one gate (`canApprove`).
-- `agent_capability_grants` stays readable and is NOT dropped: the contract phase deletes it. A live legacy account-read grant is copied
-- to `agent_roles` below and soft-revoked, so the owner sees and ends it in one place.
--
-- WHY ADD-ONLY (precedent 0075): permissive policies combine with OR, so each new FOR SELECT policy widens reads to
-- `owner OR legacy grant OR agent_roles row`. No existing policy body is rewritten, so writes stay owner-only and no table
-- has a policy-less window. `agent_roles_account_self_read` (0092) lets the app role read exactly the connection user's own account rows,
-- which is all these subqueries need. Scope names match `aliasesFor('account:read')` in features/agent-grants/authorization.ts.

DROP POLICY IF EXISTS "poly_copy_trade_fills_agent_roles_select" ON "poly_copy_trade_fills";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_fills_agent_roles_select" ON "poly_copy_trade_fills"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_copy_trade_fills"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_copy_trade_decisions_agent_roles_select" ON "poly_copy_trade_decisions";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_decisions_agent_roles_select" ON "poly_copy_trade_decisions"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_copy_trade_decisions"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_copy_trade_targets_agent_roles_select" ON "poly_copy_trade_targets";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_targets_agent_roles_select" ON "poly_copy_trade_targets"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_copy_trade_targets"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_wallet_connections_agent_roles_select" ON "poly_wallet_connections";--> statement-breakpoint
CREATE POLICY "poly_wallet_connections_agent_roles_select" ON "poly_wallet_connections"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_wallet_connections"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_wallet_balance_snapshots_agent_roles_select" ON "poly_wallet_balance_snapshots";--> statement-breakpoint
CREATE POLICY "poly_wallet_balance_snapshots_agent_roles_select" ON "poly_wallet_balance_snapshots"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_wallet_balance_snapshots"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_wallet_grants_agent_roles_select" ON "poly_wallet_grants";--> statement-breakpoint
CREATE POLICY "poly_wallet_grants_agent_roles_select" ON "poly_wallet_grants"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_wallet_grants"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_position_gap_actions_agent_roles_select" ON "poly_position_gap_actions";--> statement-breakpoint
CREATE POLICY "poly_position_gap_actions_agent_roles_select" ON "poly_position_gap_actions"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_position_gap_actions"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_position_gap_cohorts_agent_roles_select" ON "poly_position_gap_cohorts";--> statement-breakpoint
CREATE POLICY "poly_position_gap_cohorts_agent_roles_select" ON "poly_position_gap_cohorts"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_position_gap_cohorts"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_position_gap_reservations_agent_roles_select" ON "poly_position_gap_reservations";--> statement-breakpoint
CREATE POLICY "poly_position_gap_reservations_agent_roles_select" ON "poly_position_gap_reservations"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_position_gap_reservations"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_position_gap_runs_agent_roles_select" ON "poly_position_gap_runs";--> statement-breakpoint
CREATE POLICY "poly_position_gap_runs_agent_roles_select" ON "poly_position_gap_runs"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_position_gap_runs"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint
DROP POLICY IF EXISTS "poly_algorithm_input_snapshots_agent_roles_select" ON "poly_algorithm_input_snapshots";--> statement-breakpoint
CREATE POLICY "poly_algorithm_input_snapshots_agent_roles_select" ON "poly_algorithm_input_snapshots"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    EXISTS (
      SELECT 1 FROM agent_roles role_row
      WHERE role_row.resource = 'account'
        AND role_row.account_id = "poly_algorithm_input_snapshots"."billing_account_id"
        AND role_row.principal_user_id = current_setting('app.current_user_id', true)
        AND role_row.approved_by IS NOT NULL
        AND role_row.revoked_at IS NULL
        AND (role_row.expires_at IS NULL OR role_row.expires_at > now())
        AND role_row.scope IN ('account:read','performance:read')
    )
  );--> statement-breakpoint

-- The ONE live predicate for an account grant, in SQL (template 0041). SECURITY INVOKER: it runs with the caller's rights and sees only what
-- `agent_roles_account_self_read` shows that caller, so RLS cannot be widened by the function. It backs the gated account credits read
-- (GET /api/v1/accounts/{accountId}/credits, the route twin of `account:read`), so the app door and the database agree.
GRANT SELECT ON "agent_roles" TO CURRENT_USER;--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_has_scope(p_account_id text, p_scope text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.agent_roles r
    WHERE r.resource = 'account'
      AND r.principal_user_id = current_setting('app.current_user_id', true)
      AND r.scope = p_scope
      AND r.account_id = p_account_id
      AND r.approved_by IS NOT NULL
      AND r.revoked_at IS NULL
      AND (r.expires_at IS NULL OR r.expires_at > now())
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_has_scope(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_has_scope(text, text) TO CURRENT_USER;--> statement-breakpoint
DROP POLICY IF EXISTS "agent_delegated_read" ON "billing_accounts";--> statement-breakpoint
CREATE POLICY "agent_delegated_read" ON "billing_accounts" AS PERMISSIVE FOR SELECT TO public
  USING (agent_has_scope("id", 'account:read'));--> statement-breakpoint
DROP POLICY IF EXISTS "agent_delegated_read" ON "credit_ledger";--> statement-breakpoint
CREATE POLICY "agent_delegated_read" ON "credit_ledger" AS PERMISSIVE FOR SELECT TO public
  USING (agent_has_scope("billing_account_id", 'account:read'));--> statement-breakpoint

-- Backfill (data only, idempotent). The migrating role sees no tenant under FORCE RLS, so lift FORCE for this step only
-- (precedent 0037, 0044); it runs inside the migration transaction. One live row per (AI, scope) holds until the contract migration,
-- so a grantee with several legacy accounts keeps the newest as the migrated row; the others stay honored in the legacy table.
ALTER TABLE "agent_capability_grants" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_accounts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "agent_roles" ("principal_user_id", "scope", "approved_by", "granted_at", "resource", "account_id", "expires_at")
SELECT DISTINCT ON (g.grantee_principal_id)
  g.grantee_principal_id, 'account:read', g.created_by_user_id, g.created_at, 'account', g.billing_account_id, g.expires_at
FROM "agent_capability_grants" g
JOIN "billing_accounts" b ON b.id = g.billing_account_id AND b.owner_user_id = g.created_by_user_id
WHERE g.revoked_at IS NULL
  AND g.expires_at > now()
  AND g.scopes && ARRAY['account:read','performance:read']::text[]
  AND g.created_by_user_id <> g.grantee_principal_id
  AND NOT EXISTS (
    SELECT 1 FROM "agent_roles" r
    WHERE r.principal_user_id = g.grantee_principal_id AND r.scope = 'account:read' AND r.revoked_at IS NULL
  )
ORDER BY g.grantee_principal_id, g.created_at DESC;--> statement-breakpoint
UPDATE "agent_capability_grants" g
SET revoked_at = now(), revoked_by_user_id = g.created_by_user_id, updated_at = now()
WHERE g.revoked_at IS NULL
  AND g.scopes <@ ARRAY['account:read','performance:read']::text[]
  AND EXISTS (
    SELECT 1 FROM "agent_roles" r
    WHERE r.principal_user_id = g.grantee_principal_id
      AND r.account_id = g.billing_account_id
      AND r.resource = 'account'
      AND r.scope = 'account:read'
      AND r.revoked_at IS NULL
      AND r.approved_by = g.created_by_user_id
  );--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" FORCE ROW LEVEL SECURITY;
