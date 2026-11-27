-- Poly 0093 (EXPAND): the account-read grant moves onto the shared identity plane (story.0090 item 6). It copies the rows and rewrites the policies. It drops NOTHING.
-- APPROVED: CEO direction 2026-11-26/27 ("the poly quant rls read access is now going to be available as a grant in the new identity (plugin) system"): forward-looking only, no
--   rename shim, no dual read. Live rows are copied forward, and any row that cannot be mapped ABORTS the migration.
-- EXPAND, THEN CONTRACT: `agent_capability_grants` and `agent_access_requests` stay in the database, untouched, so a pod still running the previous release keeps working while
--   this release rolls out. No code of this release reads or writes either table. A later CONTRACT migration (task.0210, under task.0205) drops them in the release after this
--   one is live on production. That migration must first prove that no legacy row is missing from agent_roles (a row written by an old pod after this copy).
-- What it does, in one transaction (drizzle runs one migration file as one transaction; any RAISE rolls back every statement, including the FORCE lifts):
--   1. Adds the package SQL tail `agent_account_grants.sql` (agent-grants 0.11.0): the table privilege and `agent_has_scope(account, scope)`, the ONE live predicate.
--   2. Lifts FORCE row-level security on the tables the copy must read or write (the migration role is the table owner and sees no tenant), and restores it at the end.
--      `billing_accounts` is NOT among them: foreign-key checks bypass row-level security and no statement reads a billing_accounts row, so it keeps its lock-free FORCE.
--   3. GUARDS, then COPIES. Each guard RAISES EXCEPTION, naming the offending ids, and writes nothing. A guard counts only rows that carry authority: a row is LIVE when it is
--      not revoked and not expired. An expired grant authorizes nothing (it is history, like a closed request), so it is neither copied nor counted.
--        G0  agent_roles holds no account row yet (the target is empty; nothing of unknown provenance is overwritten).
--        G1a every grant to be copied (revoked, or not yet expired) carries `account:read` or its alias `performance:read`. The five reserved scopes (`research:run`, `policy:propose`,
--            `paper:assign`, `live:approve`, `live:assign`) were never enforced and have no declared grant, so they are not carried; a grant with ONLY reserved scopes authorized nothing
--            and aborts, because there is nothing to map it to.
--        G1b the grantee is not its own approver (agent_roles_no_self_approval).
--        G1c a revoked row was revoked by its approver (agent_roles keeps no revoker, so a different revoker would lose a fact).
--        G1d a grantee holds at most ONE LIVE grant (agent_roles allows one live row per principal and scope, EXPAND PHASE, task.5484).
--        G2  a pending, unexpired access request does not sit beside a LIVE grant of the same requester.
--        G3  the principal backfill rests on one assumption: a user with no trace of a human path (no wallet, binding, profile or identity event) is an outside agent. Every human
--            path writes such a trace and only a signed-in human approves or revokes a grant, so a user to be labelled an agent that ever approved, revoked or decided a legacy
--            grant contradicts the assumption. The migration aborts and names that user instead of labelling a person as an agent.
--      Copy:  every grant to be copied -> ONE agent_roles row (same id; resource 'account'; scope `account:read`; approved_by = created_by_user_id; granted_at = created_at;
--             account_id = billing_account_id; revoked_at and expires_at carried unchanged, so a grant still ends on its own date; requested_by = the requester of the
--             request that approved it, when there is one). A grant holding both alias names becomes one row.
--             Every pending, unexpired access request -> one OFF ask row (same id; link_hash = approval_token_hash; link_expires_at = approval_token_expires_at).
--             The legacy link (`/profile#agent-request=<token>`, sha-256 hex of the 43-character token) is the package link, so an outstanding link still opens.
--      Then it asserts: rows copied = grants to copy + pending asks; no mapped row is missing.
--   4. Backfills an external `agent_principals` row for the outside agents of THIS plane only: the grantees and requesters it copied, by node-template 0044's rule (precision over
--      coverage). It labels no other user. Data only, idempotent.
--   5. Rewrites the 11 delegated SELECT policies to `agent_has_scope(billing_account_id, 'account:read')` (owner clauses unchanged): poly_copy_trade_{fills,decisions,targets},
--      poly_wallet_{connections,balance_snapshots,grants}, poly_position_gap_{actions,cohorts,reservations,runs}, poly_algorithm_input_snapshots. ALTER POLICY: there is no policy-less window.
-- Deliberately NOT carried (recorded, not hidden): expired grants that were never revoked; closed access-request rows (approved, denied, expired, revoked); the requested end date and
--   display name of an ask. They are history. Only a grant row ever authorized a read (GRANT_IS_AUTHORITY), and every live or revoked grant is copied. The legacy tables keep all of it
--   until the contract migration, which must carry it forward or record the CEO's acceptance of the loss. An approved request lives on as `requested_by`.
-- Rolling-deploy drift (recorded, one roll long): an OLD pod keeps writing the legacy tables after this copy and nothing syncs them. A grant it makes is invisible to the new
--   plane (fail closed, D2). A REVOKE it makes is invisible too: the copied agent_roles row stays live until its own end date, at most 30 days (D1, the fail-open direction).
--   task.0210 requires both drift counts at 0 before the drop.
-- LOCKS: every table named in step 2 and the 11 policy tables (ALTER POLICY) take ACCESS EXCLUSIVE until the batch commits. `SET LOCAL lock_timeout` below makes a blocked lock fail
--   the migrate fast, with the old release still serving, instead of queueing every read of `users` behind it.
-- Known narrowing: one account per outside AI per permission until task.5484 (guard G1d). Counts are not assumed: the file never reads production counts at write time.
--   The contract task requires a read-only count of each guarded shape on candidate and production before the drop.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
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

  -- A grant is COPIED when it is revoked (history) or not yet expired. An expired, never-revoked grant authorizes nothing and is left behind.
  -- G1a: a grant to copy that carries no account-read scope.
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT "id" FROM "agent_capability_grants"
    WHERE ("revoked_at" IS NOT NULL OR "expires_at" > now()) AND NOT ("scopes" && ARRAY['account:read','performance:read']::text[])
    ORDER BY "created_at" LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1a: grants hold no account:read or performance:read scope and cannot be mapped (first ids): %', bad;
  END IF;
  -- G1b: a grantee that approved itself.
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT "id" FROM "agent_capability_grants"
    WHERE ("revoked_at" IS NOT NULL OR "expires_at" > now()) AND "created_by_user_id" = "grantee_principal_id" ORDER BY "created_at" LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1b: grants name their grantee as approver (agent_roles_no_self_approval): %', bad;
  END IF;
  -- G1c: a revoker that differs from the approver (agent_roles keeps no revoker).
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT "id" FROM "agent_capability_grants" WHERE "revoked_at" IS NOT NULL AND "revoked_by_user_id" IS DISTINCT FROM "created_by_user_id" ORDER BY "created_at" LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1c: revoked grants were revoked by someone other than their approver; the revoker has no column in agent_roles: %', bad;
  END IF;
  -- G1d: one LIVE grant per grantee (agent_roles_live_unique is per principal and scope).
  SELECT string_agg(s.grantee, ', ') INTO bad FROM (
    SELECT "grantee_principal_id" AS grantee FROM "agent_capability_grants"
    WHERE "revoked_at" IS NULL AND "expires_at" > now() GROUP BY "grantee_principal_id" HAVING count(*) > 1 LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G1d: grantees hold more than one live grant (one account per AI per permission until task.5484): %', bad;
  END IF;
  -- G2: a pending ask must not sit beside a LIVE grant of the same requester.
  SELECT string_agg(s.id::text, ', ') INTO bad FROM (
    SELECT r."id" FROM "agent_access_requests" r
    WHERE r."status" = 'pending' AND r."approval_token_expires_at" > now()
      AND EXISTS (SELECT 1 FROM "agent_capability_grants" g WHERE g."grantee_principal_id" = r."requester_principal_id" AND g."revoked_at" IS NULL AND g."expires_at" > now())
    LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G2: pending access requests sit beside a live grant of the same requester: %', bad;
  END IF;
  -- G3: the principal backfill labels a no-trace user an outside agent. A user that ever approved, revoked or decided a legacy grant is a signed-in human.
  SELECT string_agg(s.id, ', ') INTO bad FROM (
    SELECT u."id" FROM "users" u
    WHERE u."id" IN (
        SELECT g."grantee_principal_id" FROM "agent_capability_grants" g WHERE g."revoked_at" IS NOT NULL OR g."expires_at" > now()
        UNION SELECT r."requester_principal_id" FROM "agent_access_requests" r WHERE r."status" = 'pending' AND r."approval_token_expires_at" > now())
      AND u."wallet_address" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "user_bindings" b WHERE b."user_id" = u."id")
      AND NOT EXISTS (SELECT 1 FROM "user_profiles" p WHERE p."user_id" = u."id")
      AND NOT EXISTS (SELECT 1 FROM "identity_events" e WHERE e."user_id" = u."id")
      AND (EXISTS (SELECT 1 FROM "agent_capability_grants" g WHERE g."created_by_user_id" = u."id" OR g."revoked_by_user_id" = u."id")
        OR EXISTS (SELECT 1 FROM "agent_access_requests" r WHERE r."decision_by_user_id" = u."id"))
    LIMIT 20) s;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION '0093 guard G3: users with no trace of a human path approved, revoked or decided a legacy grant, so labelling them outside agents is unsafe: %', bad;
  END IF;

  SELECT count(*) INTO n_grants FROM "agent_capability_grants" WHERE "revoked_at" IS NOT NULL OR "expires_at" > now();
  SELECT count(*) INTO n_asks FROM "agent_access_requests" WHERE "status" = 'pending' AND "approval_token_expires_at" > now();

  INSERT INTO "agent_roles" ("id", "principal_user_id", "scope", "approved_by", "granted_at", "requested_by", "created_at", "revoked_at", "resource", "account_id", "expires_at")
  SELECT g."id", g."grantee_principal_id", 'account:read', g."created_by_user_id", g."created_at",
         (SELECT r."requester_principal_id" FROM "agent_access_requests" r WHERE r."approved_grant_id" = g."id"),
         g."created_at", g."revoked_at", 'account', g."billing_account_id", g."expires_at"
  FROM "agent_capability_grants" g
  WHERE g."revoked_at" IS NOT NULL OR g."expires_at" > now();

  INSERT INTO "agent_roles" ("id", "principal_user_id", "scope", "approved_by", "requested_by", "created_at", "resource", "link_hash", "link_expires_at")
  SELECT r."id", r."requester_principal_id", 'account:read', NULL, r."requester_principal_id", r."created_at", 'account', r."approval_token_hash", r."approval_token_expires_at"
  FROM "agent_access_requests" r WHERE r."status" = 'pending' AND r."approval_token_expires_at" > now();

  -- Post-condition: nothing mapped went missing.
  SELECT count(*) INTO n_roles FROM "agent_roles" WHERE "resource" = 'account';
  IF n_roles <> n_grants + n_asks THEN
    RAISE EXCEPTION '0093 post-condition: copied % account rows, expected % (% grants + % asks)', n_roles, n_grants + n_asks, n_grants, n_asks;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "agent_capability_grants" g
    WHERE (g."revoked_at" IS NOT NULL OR g."expires_at" > now())
      AND NOT EXISTS (SELECT 1 FROM "agent_roles" a WHERE a."id" = g."id" AND a."account_id" = g."billing_account_id" AND a."principal_user_id" = g."grantee_principal_id")) THEN
    RAISE EXCEPTION '0093 post-condition: a legacy grant to copy has no matching agent_roles row';
  END IF;
END
$poly0093_copy$;--> statement-breakpoint
-- Principals (node-template 0044's rule, narrowed to this plane): an external row for each copied grantee and requester. Precision over coverage: a user with ANY trace of a human path gets none.
INSERT INTO "agent_principals" ("kind", "user_id")
SELECT 'external', u."id"
FROM "users" u
WHERE u."id" IN (SELECT "principal_user_id" FROM "agent_roles" WHERE "resource" = 'account')
  AND u."wallet_address" IS NULL
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
ALTER TABLE "agent_capability_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_access_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_roles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_principals" FORCE ROW LEVEL SECURITY;
