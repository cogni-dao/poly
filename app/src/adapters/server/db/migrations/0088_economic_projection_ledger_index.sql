CREATE INDEX "poly_copy_trade_fills_economic_projection_idx" ON "poly_copy_trade_fills" USING btree (
  "billing_account_id",
  "mode",
  lower(NULLIF(COALESCE(
    NULLIF("attributes"->>'condition_id', ''),
    NULLIF(regexp_replace("market_id", '^prediction-market:polymarket:', ''), '')
  ), '')),
  NULLIF("attributes"->>'token_id', ''),
  "updated_at" DESC NULLS LAST,
  "observed_at" DESC NULLS LAST,
  "client_order_id" DESC NULLS LAST,
  "target_id",
  "fill_id"
) WHERE lower(NULLIF(COALESCE(
    NULLIF("poly_copy_trade_fills"."attributes"->>'condition_id', ''),
    NULLIF(regexp_replace("poly_copy_trade_fills"."market_id", '^prediction-market:polymarket:', ''), '')
  ), '')) IS NOT NULL
  AND NULLIF("poly_copy_trade_fills"."attributes"->>'token_id', '') IS NOT NULL
  AND (
    "poly_copy_trade_fills"."position_lifecycle" IS NOT NULL
    OR CASE
      WHEN COALESCE("poly_copy_trade_fills"."attributes"->>'filled_size_usdc', '') ~ '^[0-9]+(\.[0-9]+)?$'
        THEN ("poly_copy_trade_fills"."attributes"->>'filled_size_usdc')::numeric > 0
      ELSE false
    END
    OR (
      "poly_copy_trade_fills"."status" IN ('filled', 'partial')
      AND COALESCE("poly_copy_trade_fills"."attributes"->>'size_usdc', '') ~ '^[0-9]+(\.[0-9]+)?$'
      AND ("poly_copy_trade_fills"."attributes"->>'size_usdc')::numeric > 0
    )
  );
