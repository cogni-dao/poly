-- Poly 0093: the account-read grant moves onto the shared identity plane. Poly's own grant plane (`agent_capability_grants`, `agent_access_requests`) is purged (story.0090 item 6).
-- APPROVED: CEO direction 2026-11-26/27 ("the poly quant rls read access is now going to be available as a grant in the new identity (plugin) system"):
--   purge, clean, forward-looking only; no rename shim, no dual read. Live rows are copied forward, and any row that cannot be mapped ABORTS the migration.
-- What it does, in one transaction (drizzle runs one migration file as one transaction; any RAISE rolls back every statement, including the FORCE lifts below):
--   1. Adds the package SQL tail `agent_account_grants.sql` (agent-grants 0.11.0): the table privilege and `agent_has_scope(account, scope)`, the ONE live predicate.
--   2. Lifts FORCE row-level security on the tables the copy must read or write (the migration role is the table owner and sees no tenant), and restores it at the end.
--   3. GUARDS, then COPIES. Each guard RAISES EXCEPTION, naming the offending ids, and writes nothing. The copy never drops a row silently.
--        G0  agent_roles holds no account row yet (the target is empty; nothing of unknown provenance is overwritten).
--        G1  every legacy grant maps mechanically: its scopes are only `account:read` / `performance:read` (the alias; the five reserved scopes `research:run`,
--            `policy:propose`, `paper:assign`, `live:approve`, `live:assign` were never enforced and have no declared grant); the grantee is not its own approver
--            (agent_roles_no_self_approval); a revoked row was revoked by its approver (agent_roles keeps no revoker, so a different revoker would lose a fact);
--            a grantee holds at most ONE non-revoked grant (agent_roles allows one live row per principal and scope, EXPAND PHASE, task.5484).
--        G2  a pending, unexpired access request can become an ask row: its requester has no other non-revoked row.
--      Copy:  every grant row -> ONE agent_roles row (same id; resource 'account'; scope `account:read`; approved_by = created_by_user_id; granted_at = created_at;
--             account_id = billing_account_id; revoked_at and expires_at carried unchanged, so a grant still ends on its own date; requested_by = the requester of the
--             request that approved it, when there is one). A grant holding both alias names becomes one row.
--             Every pending, unexpired access request -> one OFF ask row (same id; link_hash = approval_token_hash; link_expires_at = approval_token_expires_at).
--             The legacy link (`/profile#agent-request=<token>`, sha-256 hex of the 43-character token) is the package link, so an outstanding link still opens.
--      Then it asserts: rows copied = grants + pending asks; no mapped row is missing.
--   4. Backfills an external `agent_principals` row for every earlier outside agent (node-template 0044: precision over coverage; a user with a wallet, a binding, a profile
--      or an identity event is a human and gets none). Data only, idempotent.
--   5. Rewrites the 11 delegated SELECT policies to `agent_has_scope(billing_account_id, 'account:read')` (owner clauses unchanged): poly_copy_trade_{fills,decisions,targets},
--      poly_wallet_{connections,balance_snapshots,grants}, poly_position_gap_{actions,cohorts,reservations,runs}, poly_algorithm_input_snapshots. ALTER POLICY: there is no policy-less window.
--   6. Guards the drop: no policy, view, function or foreign key outside the two legacy tables may still name them. Then drops agent_access_requests and agent_capability_grants. No CASCADE.
-- Deliberately NOT carried (recorded, not hidden): closed access-request rows (approved, denied, expired, revoked) and the requested end date and display name of an ask. They are
--   lifecycle history (GRANT_IS_AUTHORITY: only the grant row ever authorized a read, and every grant is copied above). An approved request lives on as `requested_by`.
--   A grant's own `updated_at` and `revoked_by_user_id` are not kept (the revoker equals the approver by guard G1).
-- Evidence and risk, for the reviewer: the rows are read through the table owner, so counts are only knowable at migration time; this file therefore never assumes a count. A production
--   row that fails a guard stops the rollout with its ids in the error (the node-template 0039 precedent). Known narrowing: one account per outside AI per permission until task.5484.
-- Deliberately NOT here: the AGENT_WALLET_IS_NOT_A_PAYEE trigger and wallet-binding rules (node-template 0043) and `agent_credentials`: no agent wallet binding or credential route exists in Poly yet.
GRANT SELECT ON "agent_roles" TO CURRENT_USER;--> statement-breakpoint
-- The ONE live predicate for an account grant, in SQL (package tail agent_account_grants.sql, 0.11.0, verbatim). SECURITY INVOKER: it sees only what the agent_roles policy lets the caller see.
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
ALTER TABLE "agent_capability_grants" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_access_requests" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_accounts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $poly0093_copy$
DECLARE
  bad text;
  n_grants integer;
  n_asks integer;
  n_roles integer;
BEGIN
  -- G0: the target is empty.
  IF EXISTS (SELECT 1 FROM "agent_roles" WHERE "resource" = 'account') THEN
    RAISE EXCEPTION '0093 guard G0: agent_roles already holds account rows; refusing to copy over rows of unknown provenance';
  END IF;

  -- G1a: scopes the shared plane has no grant for.
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT "id" FROM "agent_capability_grants" WHERE NOT ("scopes" <@ ARRAY['account:read','performance:read']::text[]) ORDER BY "created_at" LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1a: grants hold a scope other than account:read or performance:read and cannot be mapped (first ids): %', bad;
  END IF;
  -- G1b: a grantee that approved itself.
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT "id" FROM "agent_capability_grants" WHERE "created_by_user_id" = "grantee_principal_id" ORDER BY "created_at" LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1b: grants name their grantee as approver (agent_roles_no_self_approval): %', bad;
  END IF;
  -- G1c: a revoker that differs from the approver (agent_roles keeps no revoker).
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT "id" FROM "agent_capability_grants" WHERE "revoked_at" IS NOT NULL AND "revoked_by_user_id" IS DISTINCT FROM "created_by_user_id" ORDER BY "created_at" LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1c: revoked grants were revoked by someone other than their approver; the revoker has no column in agent_roles: %', bad;
  END IF;
  -- G1d: one non-revoked grant per grantee (agent_roles_live_unique is per principal and scope).
  SELECT string_agg(s.grantee, ', ') INTO bad FROM (
    SELECT "grantee_principal_id" AS grantee FROM "agent_capability_grants" WHERE "revoked_at" IS NULL GROUP BY "grantee_principal_id" HAVING count(*) > 1 LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1d: grantees hold more than one non-revoked grant (one account per AI per permission until task.5484): %', bad;
  END IF;
  -- G2: a pending ask must not collide with a non-revoked grant of the same requester.
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT r."id" FROM "agent_access_requests" r
    WHERE r."status" = 'pending' AND r."approval_token_expires_at" > now()
      AND EXISTS (SELECT 1 FROM "agent_capability_grants" g WHERE g."grantee_principal_id" = r."requester_principal_id" AND g."revoked_at" IS NULL)
    LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G2: pending access requests collide with a non-revoked grant of the same requester: %', bad;
  END IF;

  SELECT count(*) INTO n_grants FROM "agent_capability_grants";
  SELECT count(*) INTO n_asks FROM "agent_access_requests" WHERE "status" = 'pending' AND "approval_token_expires_at" > now();

  INSERT INTO "agent_roles" ("id", "principal_user_id", "scope", "approved_by", "granted_at", "requested_by", "created_at", "revoked_at", "resource", "account_id", "expires_at")
  SELECT g."id", g."grantee_principal_id", 'account:read', g."created_by_user_id", g."created_at",
         (SELECT r."requester_principal_id" FROM "agent_access_requests" r WHERE r."approved_grant_id" = g."id"),
         g."created_at", g."revoked_at", 'account', g."billing_account_id", g."expires_at"
  FROM "agent_capability_grants" g;

  INSERT INTO "agent_roles" ("id", "principal_user_id", "scope", "approved_by", "requested_by", "created_at", "resource", "link_hash", "link_expires_at")
  SELECT r."id", r."requester_principal_id", 'account:read', NULL, r."requester_principal_id", r."created_at", 'account', r."approval_token_hash", r."approval_token_expires_at"
  FROM "agent_access_requests" r WHERE r."status" = 'pending' AND r."approval_token_expires_at" > now();

  -- Post-condition: nothing mapped went missing.
  SELECT count(*) INTO n_roles FROM "agent_roles" WHERE "resource" = 'account';
  IF n_roles <> n_grants + n_asks THEN
    RAISE EXCEPTION '0093 post-condition: copied % account rows, expected % (% grants + % asks)', n_roles, n_grants + n_asks, n_grants, n_asks;
  END IF;
  IF EXISTS (SELECT 1 FROM "agent_capability_grants" g WHERE NOT EXISTS (SELECT 1 FROM "agent_roles" a WHERE a."id" = g."id" AND a."account_id" = g."billing_account_id" AND a."principal_user_id" = g."grantee_principal_id")) THEN
    RAISE EXCEPTION '0093 post-condition: a legacy grant has no matching agent_roles row';
  END IF;
END
$poly0093_copy$;--> statement-breakpoint
-- Principals (node-template 0044): an external row for every earlier outside agent. Precision over coverage: a user with ANY trace of a human path gets none.
INSERT INTO "agent_principals" ("kind", "user_id")
SELECT 'external', u."id"
FROM "users" u
WHERE u."wallet_address" IS NULL
  AND u."id" <> '00000000-0000-4000-a000-000000000001'
  AND NOT EXISTS (SELECT 1 FROM "user_bindings" b WHERE b."user_id" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "user_profiles" p WHERE p."user_id" = u."id")
  AND NOT EXISTS (SELECT 1 FROM "identity_events" e WHERE e."user_id" = u."id")
ON CONFLICT ("user_id") DO NOTHING;--> statement-breakpoint
ALTER POLICY "poly_copy_trade_fills_select" ON "poly_copy_trade_fills" TO public USING ("poly_copy_trade_fills"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_copy_trade_fills"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_copy_trade_decisions_select" ON "poly_copy_trade_decisions" TO public USING ("poly_copy_trade_decisions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_copy_trade_decisions"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_copy_trade_targets_select" ON "poly_copy_trade_targets" TO public USING ("poly_copy_trade_targets"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_copy_trade_targets"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_wallet_connections_delegated_select" ON "poly_wallet_connections" TO public USING (agent_has_scope("poly_wallet_connections"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_wallet_balance_snapshots_delegated_select" ON "poly_wallet_balance_snapshots" TO public USING (agent_has_scope("poly_wallet_balance_snapshots"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_wallet_grants_delegated_select" ON "poly_wallet_grants" TO public USING ("poly_wallet_grants"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_wallet_grants"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_position_gap_actions_select" ON "poly_position_gap_actions" TO public USING ("poly_position_gap_actions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_position_gap_actions"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_position_gap_cohorts_select" ON "poly_position_gap_cohorts" TO public USING ("poly_position_gap_cohorts"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_position_gap_cohorts"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_position_gap_reservations_select" ON "poly_position_gap_reservations" TO public USING ("poly_position_gap_reservations"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_position_gap_reservations"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_position_gap_runs_select" ON "poly_position_gap_runs" TO public USING ("poly_position_gap_runs"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_position_gap_runs"."billing_account_id", 'account:read'));--> statement-breakpoint
ALTER POLICY "poly_algorithm_input_snapshots_select" ON "poly_algorithm_input_snapshots" TO public USING ("poly_algorithm_input_snapshots"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR agent_has_scope("poly_algorithm_input_snapshots"."billing_account_id", 'account:read'));--> statement-breakpoint
DO $poly0093_drop$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(format('policy %s on %s', p.polname, c.relname), ', ') INTO bad
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  WHERE c.relname NOT IN ('agent_capability_grants', 'agent_access_requests')
    AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') ~ 'agent_capability_grants|agent_access_requests'
      OR coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'agent_capability_grants|agent_access_requests');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0093 drop guard: still referenced by %', bad; END IF;
  SELECT string_agg(format('view %s', v.viewname), ', ') INTO bad
  FROM pg_views v WHERE v.schemaname = 'public' AND v.definition ~ 'agent_capability_grants|agent_access_requests';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0093 drop guard: still referenced by %', bad; END IF;
  SELECT string_agg(format('function %s', f.proname), ', ') INTO bad
  FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
  WHERE n.nspname = 'public' AND f.prosrc ~ 'agent_capability_grants|agent_access_requests';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0093 drop guard: still referenced by %', bad; END IF;
  SELECT string_agg(format('foreign key %s on %s', k.conname, k.conrelid::regclass), ', ') INTO bad
  FROM pg_constraint k
  WHERE k.contype = 'f'
    AND k.confrelid IN (to_regclass('public.agent_capability_grants'), to_regclass('public.agent_access_requests'))
    AND k.conrelid NOT IN (to_regclass('public.agent_capability_grants'), to_regclass('public.agent_access_requests'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0093 drop guard: still referenced by %', bad; END IF;
END
$poly0093_drop$;--> statement-breakpoint
-- The only foreign key between the two points from the requests to the grants: drop the requests first. No CASCADE: an unexpected dependent aborts the migration.
DROP TABLE "agent_access_requests";--> statement-breakpoint
DROP TABLE "agent_capability_grants";--> statement-breakpoint
ALTER TABLE "billing_accounts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
