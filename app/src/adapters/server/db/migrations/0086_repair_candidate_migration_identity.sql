-- bug.5415 — one cancelled candidate flight applied the SQL later shipped as
-- 0073 under the temporary 0071_absent_justice identity. Drizzle records only
-- (sha256(sql), journal timestamp), so candidate-a now reports that temporary
-- tuple as unexpected and canonical 0071_gigantic_sister_grimm as missing.
--
-- This migration repairs tracking metadata only. It accepts exactly the one
-- observed tuple, and only after the canonical forward repairs at 0072/0073
-- are recorded and their required schema objects exist. Clean histories no-op;
-- duplicates, partial histories, or any other tuple fail closed. The DO block
-- and Drizzle's own ledger insert run in one migration transaction.
DO $migration$
DECLARE
  canonical_0071_count integer;
  polluted_0071_count integer;
  repaired_count integer;
  target_policy_names text[];
BEGIN
  SELECT
    count(*) FILTER (
      WHERE hash = '6753c89a9c1eace1aaf11e37e4627937db2afa89f5df0ff93c5f1a4d0000f763'
        AND created_at = 1791096737117
    ),
    count(*) FILTER (
      WHERE hash = '1d1ea3793363f479929e7d79c6866bf611268ec016565d83f0616b73bd4f50a6'
        AND created_at = 1791098285556
    )
  INTO canonical_0071_count, polluted_0071_count
  FROM drizzle.__drizzle_migrations;

  -- Every database created from canonical history already has the desired row.
  IF canonical_0071_count = 1 AND polluted_0071_count = 0 THEN
    RETURN;
  END IF;

  IF canonical_0071_count <> 0 OR polluted_0071_count <> 1 THEN
    RAISE EXCEPTION
      '0086 unsupported migration ledger shape: canonical_0071=%, polluted_0071=%',
      canonical_0071_count,
      polluted_0071_count;
  END IF;

  -- These exact migrations are the forward schema repairs for the two 0071
  -- branches. Never relabel the old row before both have completed.
  IF NOT EXISTS (
    SELECT 1
    FROM drizzle.__drizzle_migrations
    WHERE hash = 'eb5031443af7050ac13251fd9233a38e979f0534ab28a6989b94a7eba061c31a'
      AND created_at = 1791102630890
  ) OR NOT EXISTS (
    SELECT 1
    FROM drizzle.__drizzle_migrations
    WHERE hash = '30aafc869c54e4b1611c29625bde6c064ab1b11609b8ec22057aa523af62419b'
      AND created_at = 1791109877528
  ) THEN
    RAISE EXCEPTION '0086 canonical 0072/0073 repair history is incomplete';
  END IF;

  IF to_regclass('public.agent_access_requests') IS NULL
    OR to_regclass('public.poly_copy_trade_decisions_investigation_idx') IS NULL
    OR to_regclass('public.poly_copy_trade_fills_investigation_idx') IS NULL
  THEN
    RAISE EXCEPTION '0086 canonical 0071/0073 schema preconditions are missing';
  END IF;

  SELECT COALESCE(
    array_agg(policy_row.polname::text ORDER BY policy_row.polname::text),
    ARRAY[]::text[]
  )
  INTO target_policy_names
  FROM pg_catalog.pg_policy policy_row
  WHERE policy_row.polrelid = 'public.poly_copy_trade_targets'::regclass;

  IF target_policy_names <> ARRAY[
    'poly_copy_trade_targets_delete',
    'poly_copy_trade_targets_insert',
    'poly_copy_trade_targets_select',
    'poly_copy_trade_targets_update'
  ]::text[] THEN
    RAISE EXCEPTION '0086 canonical 0073 target-policy precondition is missing';
  END IF;

  UPDATE drizzle.__drizzle_migrations
  SET
    hash = '6753c89a9c1eace1aaf11e37e4627937db2afa89f5df0ff93c5f1a4d0000f763',
    created_at = 1791096737117
  WHERE hash = '1d1ea3793363f479929e7d79c6866bf611268ec016565d83f0616b73bd4f50a6'
    AND created_at = 1791098285556;

  GET DIAGNOSTICS repaired_count = ROW_COUNT;
  IF repaired_count <> 1 THEN
    RAISE EXCEPTION '0086 expected one repaired ledger row, updated %', repaired_count;
  END IF;
END
$migration$;--> statement-breakpoint
