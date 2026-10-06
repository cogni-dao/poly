-- Candidate-a migration-identity convergence:
-- cancelled flight 37186510581 applied this byte-identical DDL from source
-- a12a70ff0e6910825c2f06c9a6ccfe8785709ffc as 0071_absent_justice at
-- journal timestamp 1791098285556 (DDL sha256
-- 1d1ea3793363f479929e7d79c6866bf611268ec016565d83f0616b73bd4f50a6).
-- The migration was subsequently renumbered to 0073, so every create below
-- converges only an absent object and then fails closed unless the resulting
-- catalog is exactly canonical. All statements remain in Drizzle's migration
-- transaction; any failed assertion rolls the whole migration back.
CREATE INDEX IF NOT EXISTS "poly_copy_trade_decisions_investigation_idx" ON "poly_copy_trade_decisions" USING btree ("billing_account_id",("intent"->>'market_id'),"mode","decided_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_fills_investigation_idx" ON "poly_copy_trade_fills" USING btree ("billing_account_id","market_id","mode","observed_at" DESC NULLS LAST,"target_id" DESC NULLS LAST,"fill_id" DESC NULLS LAST);--> statement-breakpoint

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index index_row
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_class table_relation
      ON table_relation.oid = index_row.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = index_relation.relam
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = 'poly_copy_trade_decisions_investigation_idx'
      AND index_relation.relkind = 'i'
      AND table_namespace.nspname = 'public'
      AND table_relation.relname = 'poly_copy_trade_decisions'
      AND access_method.amname = 'btree'
      AND NOT index_row.indisunique
      AND NOT index_row.indisprimary
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND pg_catalog.pg_get_indexdef(index_row.indexrelid) =
        'CREATE INDEX poly_copy_trade_decisions_investigation_idx ON public.poly_copy_trade_decisions USING btree (billing_account_id, ((intent ->> ''market_id''::text)), mode, decided_at DESC NULLS LAST, id DESC NULLS LAST)'
  ) THEN
    RAISE EXCEPTION '0073 decisions investigation index catalog mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index index_row
    JOIN pg_catalog.pg_class index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_class table_relation
      ON table_relation.oid = index_row.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_catalog.pg_am access_method
      ON access_method.oid = index_relation.relam
    WHERE index_namespace.nspname = 'public'
      AND index_relation.relname = 'poly_copy_trade_fills_investigation_idx'
      AND index_relation.relkind = 'i'
      AND table_namespace.nspname = 'public'
      AND table_relation.relname = 'poly_copy_trade_fills'
      AND access_method.amname = 'btree'
      AND NOT index_row.indisunique
      AND NOT index_row.indisprimary
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND pg_catalog.pg_get_indexdef(index_row.indexrelid) =
        'CREATE INDEX poly_copy_trade_fills_investigation_idx ON public.poly_copy_trade_fills USING btree (billing_account_id, market_id, mode, observed_at DESC NULLS LAST, target_id DESC NULLS LAST, fill_id DESC NULLS LAST)'
  ) THEN
    RAISE EXCEPTION '0073 fills investigation index catalog mismatch';
  END IF;
END
$migration$;--> statement-breakpoint

-- story.5003: delegates need target policy/config to interpret account-scoped
-- performance. The table has no signing material; writes stay owner-only.
-- The legacy policy is removed only on the clean migration path; the cancelled
-- flight already removed it atomically when it created the four named policies.
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_copy_trade_targets";--> statement-breakpoint

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy policy_row
    WHERE policy_row.polrelid = 'public.poly_copy_trade_targets'::regclass
      AND policy_row.polname = 'poly_copy_trade_targets_select'
  ) THEN
    EXECUTE $policy$
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
              AND grant_row.scopes @> ARRAY['performance:read']::text[]
          )
        )
    $policy$;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy policy_row
    WHERE policy_row.polrelid = 'public.poly_copy_trade_targets'::regclass
      AND policy_row.polname = 'poly_copy_trade_targets_insert'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "poly_copy_trade_targets_insert" ON "poly_copy_trade_targets"
        AS PERMISSIVE FOR INSERT TO public
        WITH CHECK (
          "billing_account_id" IN (
            SELECT id FROM billing_accounts
            WHERE owner_user_id = current_setting('app.current_user_id', true)
          )
          AND "created_by_user_id" = current_setting('app.current_user_id', true)
        )
    $policy$;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy policy_row
    WHERE policy_row.polrelid = 'public.poly_copy_trade_targets'::regclass
      AND policy_row.polname = 'poly_copy_trade_targets_update'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "poly_copy_trade_targets_update" ON "poly_copy_trade_targets"
        AS PERMISSIVE FOR UPDATE TO public
        USING (
          "billing_account_id" IN (
            SELECT id FROM billing_accounts
            WHERE owner_user_id = current_setting('app.current_user_id', true)
          )
        )
        WITH CHECK (
          "billing_account_id" IN (
            SELECT id FROM billing_accounts
            WHERE owner_user_id = current_setting('app.current_user_id', true)
          )
          AND "created_by_user_id" = current_setting('app.current_user_id', true)
        )
    $policy$;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy policy_row
    WHERE policy_row.polrelid = 'public.poly_copy_trade_targets'::regclass
      AND policy_row.polname = 'poly_copy_trade_targets_delete'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "poly_copy_trade_targets_delete" ON "poly_copy_trade_targets"
        AS PERMISSIVE FOR DELETE TO public
        USING (
          "billing_account_id" IN (
            SELECT id FROM billing_accounts
            WHERE owner_user_id = current_setting('app.current_user_id', true)
          )
        )
    $policy$;
  END IF;
END
$migration$;--> statement-breakpoint

DO $migration$
DECLARE
  actual_policy_names text[];
  mismatched_policy_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class table_relation
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND table_relation.relname = 'poly_copy_trade_targets'
      AND table_relation.relkind = 'r'
      AND table_relation.relrowsecurity
      AND table_relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '0073 copy-trade targets RLS catalog mismatch';
  END IF;

  SELECT COALESCE(
    array_agg(policy_row.polname::text ORDER BY policy_row.polname::text),
    ARRAY[]::text[]
  )
  INTO actual_policy_names
  FROM pg_catalog.pg_policy policy_row
  WHERE policy_row.polrelid = 'public.poly_copy_trade_targets'::regclass;

  IF actual_policy_names <> ARRAY[
    'poly_copy_trade_targets_delete',
    'poly_copy_trade_targets_insert',
    'poly_copy_trade_targets_select',
    'poly_copy_trade_targets_update'
  ]::text[] THEN
    RAISE EXCEPTION '0073 copy-trade targets policy-name set mismatch';
  END IF;

  SELECT count(*)
  INTO mismatched_policy_count
  FROM (
    VALUES
      (
        'poly_copy_trade_targets_delete',
        'd'::"char",
        $expr$(billing_account_id IN ( SELECT billing_accounts.id
   FROM billing_accounts
  WHERE (billing_accounts.owner_user_id = current_setting('app.current_user_id'::text, true))))$expr$::text,
        NULL::text
      ),
      (
        'poly_copy_trade_targets_insert',
        'a'::"char",
        NULL::text,
        $expr$((billing_account_id IN ( SELECT billing_accounts.id
   FROM billing_accounts
  WHERE (billing_accounts.owner_user_id = current_setting('app.current_user_id'::text, true)))) AND (created_by_user_id = current_setting('app.current_user_id'::text, true)))$expr$::text
      ),
      (
        'poly_copy_trade_targets_select',
        'r'::"char",
        $expr$((billing_account_id IN ( SELECT billing_accounts.id
   FROM billing_accounts
  WHERE (billing_accounts.owner_user_id = current_setting('app.current_user_id'::text, true)))) OR (EXISTS ( SELECT 1
   FROM agent_capability_grants grant_row
  WHERE ((grant_row.billing_account_id = poly_copy_trade_targets.billing_account_id) AND (grant_row.grantee_principal_id = current_setting('app.current_user_id'::text, true)) AND (grant_row.revoked_at IS NULL) AND (grant_row.expires_at > now()) AND (grant_row.scopes @> ARRAY['performance:read'::text])))))$expr$::text,
        NULL::text
      ),
      (
        'poly_copy_trade_targets_update',
        'w'::"char",
        $expr$(billing_account_id IN ( SELECT billing_accounts.id
   FROM billing_accounts
  WHERE (billing_accounts.owner_user_id = current_setting('app.current_user_id'::text, true))))$expr$::text,
        $expr$((billing_account_id IN ( SELECT billing_accounts.id
   FROM billing_accounts
  WHERE (billing_accounts.owner_user_id = current_setting('app.current_user_id'::text, true)))) AND (created_by_user_id = current_setting('app.current_user_id'::text, true)))$expr$::text
      )
  ) AS expected_policy(name, command, using_expression, check_expression)
  LEFT JOIN pg_catalog.pg_policy policy_row
    ON policy_row.polrelid = 'public.poly_copy_trade_targets'::regclass
    AND policy_row.polname = expected_policy.name
  WHERE policy_row.oid IS NULL
    OR NOT policy_row.polpermissive
    OR policy_row.polcmd <> expected_policy.command
    OR policy_row.polroles <> ARRAY[0::oid]
    OR btrim(regexp_replace(
      pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid),
      '[[:space:]]+',
      ' ',
      'g'
    )) IS DISTINCT FROM btrim(regexp_replace(
      expected_policy.using_expression,
      '[[:space:]]+',
      ' ',
      'g'
    ))
    OR btrim(regexp_replace(
      pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid),
      '[[:space:]]+',
      ' ',
      'g'
    )) IS DISTINCT FROM btrim(regexp_replace(
      expected_policy.check_expression,
      '[[:space:]]+',
      ' ',
      'g'
    ));

  IF mismatched_policy_count <> 0 THEN
    RAISE EXCEPTION '0073 copy-trade targets policy catalog mismatch';
  END IF;
END
$migration$;
