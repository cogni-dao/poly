CREATE INDEX "poly_market_metadata_condition_latest_lower_idx" ON "poly_market_metadata" USING btree (lower("condition_id"),"fetched_at" DESC NULLS LAST,"condition_id");--> statement-breakpoint
CREATE INDEX "poly_market_outcomes_condition_token_latest_lower_idx" ON "poly_market_outcomes" USING btree (lower("condition_id"),"token_id","updated_at" DESC NULLS LAST,"condition_id");--> statement-breakpoint

-- A successful 0078 must prove that both performance indexes exist on the
-- migration target with the exact planned catalog shape. This makes the
-- migration itself the deploy-order gate; no runtime cache or timeout hides a
-- missing, invalid, or differently-shaped index.
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
      AND index_relation.relname = 'poly_market_metadata_condition_latest_lower_idx'
      AND index_relation.relkind = 'i'
      AND table_namespace.nspname = 'public'
      AND table_relation.relname = 'poly_market_metadata'
      AND access_method.amname = 'btree'
      AND NOT index_row.indisunique
      AND NOT index_row.indisprimary
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND pg_catalog.pg_get_indexdef(index_row.indexrelid) =
        'CREATE INDEX poly_market_metadata_condition_latest_lower_idx ON public.poly_market_metadata USING btree (lower(condition_id), fetched_at DESC NULLS LAST, condition_id)'
  ) THEN
    RAISE EXCEPTION '0078 market metadata condition index catalog mismatch';
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
      AND index_relation.relname = 'poly_market_outcomes_condition_token_latest_lower_idx'
      AND index_relation.relkind = 'i'
      AND table_namespace.nspname = 'public'
      AND table_relation.relname = 'poly_market_outcomes'
      AND access_method.amname = 'btree'
      AND NOT index_row.indisunique
      AND NOT index_row.indisprimary
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND pg_catalog.pg_get_indexdef(index_row.indexrelid) =
        'CREATE INDEX poly_market_outcomes_condition_token_latest_lower_idx ON public.poly_market_outcomes USING btree (lower(condition_id), token_id, updated_at DESC NULLS LAST, condition_id)'
  ) THEN
    RAISE EXCEPTION '0078 market outcomes condition-token index catalog mismatch';
  END IF;
END
$migration$;
