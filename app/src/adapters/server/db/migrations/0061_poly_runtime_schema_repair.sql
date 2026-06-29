-- Migration: Repair Poly runtime schema when legacy migration rows were stamped
-- without the actual poly_* tables.
--
-- Candidate-a exposed this state: drizzle.__drizzle_migrations contained the
-- 0060 baseline row, so the normal migrator skipped 0029..0059, but the live DB
-- had no poly runtime tables. Keep this forward-only and idempotent so preview
-- and prod can self-heal through the normal initContainer path.

CREATE TABLE IF NOT EXISTS "poly_copy_trade_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "billing_account_id" text NOT NULL REFERENCES "billing_accounts"("id") ON DELETE CASCADE,
  "created_by_user_id" text NOT NULL REFERENCES "users"("id"),
  "target_wallet" text NOT NULL,
  "mirror_filter_percentile" integer NOT NULL DEFAULT 75,
  "mirror_max_usdc_per_trade" numeric(10,2) NOT NULL DEFAULT '5.00',
  "sizing_policy_kind" text NOT NULL DEFAULT 'auto',
  "target_range_max_usdc" numeric(12,2),
  "mirror_max_alloc_per_condition_usdc" numeric(10,2),
  "mirror_activated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "disabled_at" timestamptz,
  CONSTRAINT "poly_copy_trade_targets_wallet_shape" CHECK ("target_wallet" ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT "poly_copy_trade_targets_filter_percentile_range" CHECK ("mirror_filter_percentile" >= 50 AND "mirror_filter_percentile" <= 99),
  CONSTRAINT "poly_copy_trade_targets_max_bet_positive" CHECK ("mirror_max_usdc_per_trade" > 0),
  CONSTRAINT "poly_copy_trade_targets_sizing_policy_kind_check" CHECK ("sizing_policy_kind" IN ('auto','min_bet','target_percentile_scaled','position_gap','mirror_fill_exact')),
  CONSTRAINT "poly_copy_trade_targets_range_max_positive" CHECK ("target_range_max_usdc" IS NULL OR "target_range_max_usdc" > 0),
  CONSTRAINT "poly_copy_trade_targets_alloc_per_condition_positive" CHECK ("mirror_max_alloc_per_condition_usdc" IS NULL OR "mirror_max_alloc_per_condition_usdc" > 0),
  CONSTRAINT "poly_copy_trade_targets_position_gap_requires_range_knobs" CHECK ("sizing_policy_kind" <> 'position_gap' OR "disabled_at" IS NOT NULL OR ("target_range_max_usdc" IS NOT NULL AND "mirror_max_alloc_per_condition_usdc" IS NOT NULL))
);--> statement-breakpoint

ALTER TABLE "poly_copy_trade_targets" ADD COLUMN IF NOT EXISTS "mirror_filter_percentile" integer NOT NULL DEFAULT 75;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN IF NOT EXISTS "mirror_max_usdc_per_trade" numeric(10,2) NOT NULL DEFAULT '5.00';--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN IF NOT EXISTS "sizing_policy_kind" text NOT NULL DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN IF NOT EXISTS "target_range_max_usdc" numeric(12,2);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN IF NOT EXISTS "mirror_max_alloc_per_condition_usdc" numeric(10,2);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN IF NOT EXISTS "mirror_activated_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poly_copy_trade_targets_billing_wallet_active_idx" ON "poly_copy_trade_targets"("billing_account_id", "target_wallet") WHERE "disabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_targets_billing_account_idx" ON "poly_copy_trade_targets"("billing_account_id");--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_copy_trade_targets";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "poly_copy_trade_targets" USING ("created_by_user_id" = current_setting('app.current_user_id', true)) WITH CHECK ("created_by_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_copy_trade_fills" (
  "billing_account_id" text NOT NULL REFERENCES "billing_accounts"("id") ON DELETE CASCADE,
  "created_by_user_id" text NOT NULL REFERENCES "users"("id"),
  "target_id" uuid NOT NULL,
  "fill_id" text NOT NULL,
  "market_id" text NOT NULL DEFAULT '',
  "observed_at" timestamptz NOT NULL,
  "client_order_id" text NOT NULL,
  "order_id" text,
  "status" text NOT NULL,
  "position_lifecycle" text,
  "attributes" jsonb,
  "synced_at" timestamptz,
  "mode" text NOT NULL DEFAULT 'live',
  "price" numeric(18,8),
  "shares" numeric(20,8),
  "fees_usdc" numeric(20,8),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("billing_account_id", "target_id", "fill_id"),
  CONSTRAINT "poly_copy_trade_fills_status_check" CHECK ("status" IN ('pending','open','filled','partial','canceled','error')),
  CONSTRAINT "poly_copy_trade_fills_position_lifecycle_check" CHECK ("position_lifecycle" IS NULL OR "position_lifecycle" IN ('unresolved', 'open', 'closing', 'closed', 'resolving', 'winner', 'redeem_pending', 'redeemed', 'loser', 'dust', 'abandoned')),
  CONSTRAINT "poly_copy_trade_fills_mode_check" CHECK ("mode" IN ('live','paper'))
);--> statement-breakpoint

ALTER TABLE "poly_copy_trade_fills" ADD COLUMN IF NOT EXISTS "market_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN IF NOT EXISTS "position_lifecycle" text;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'live';--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN IF NOT EXISTS "price" numeric(18,8);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN IF NOT EXISTS "shares" numeric(20,8);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN IF NOT EXISTS "fees_usdc" numeric(20,8);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN IF NOT EXISTS "synced_at" timestamptz;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_fills_observed_at_idx" ON "poly_copy_trade_fills"("observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_fills_client_order_id_idx" ON "poly_copy_trade_fills"("client_order_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_poly_copy_trade_fills_synced_at" ON "poly_copy_trade_fills"("synced_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_fills_billing_account_idx" ON "poly_copy_trade_fills"("billing_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poly_copy_trade_fills_order_id_unique" ON "poly_copy_trade_fills"("order_id") WHERE "order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poly_copy_trade_fills_one_open_per_market" ON "poly_copy_trade_fills"("billing_account_id", "target_id", "market_id") WHERE "status" IN ('pending','open','partial') AND ("position_lifecycle" IS NULL OR "position_lifecycle" IN ('unresolved','open','closing')) AND "attributes"->>'closed_at' IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_fills_position_lifecycle_idx" ON "poly_copy_trade_fills"("billing_account_id", "position_lifecycle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_fills_pnl_idx" ON "poly_copy_trade_fills"("billing_account_id", "target_id", "market_id", "mode", "status");--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_copy_trade_fills";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "poly_copy_trade_fills" USING ("created_by_user_id" = current_setting('app.current_user_id', true)) WITH CHECK ("created_by_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_copy_trade_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "billing_account_id" text NOT NULL REFERENCES "billing_accounts"("id") ON DELETE CASCADE,
  "created_by_user_id" text NOT NULL REFERENCES "users"("id"),
  "target_id" uuid NOT NULL,
  "fill_id" text NOT NULL,
  "outcome" text NOT NULL,
  "reason" text,
  "intent" jsonb NOT NULL,
  "receipt" jsonb,
  "decided_at" timestamptz NOT NULL,
  "mode" text NOT NULL DEFAULT 'live',
  CONSTRAINT "poly_copy_trade_decisions_outcome_check" CHECK ("outcome" IN ('placed','skipped','error')),
  CONSTRAINT "poly_copy_trade_decisions_mode_check" CHECK ("mode" IN ('live','paper'))
);--> statement-breakpoint

ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'live';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_decisions_decided_at_idx" ON "poly_copy_trade_decisions"("decided_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_decisions_target_fill_idx" ON "poly_copy_trade_decisions"("target_id", "fill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_decisions_billing_account_idx" ON "poly_copy_trade_decisions"("billing_account_id");--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_copy_trade_decisions";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "poly_copy_trade_decisions" USING ("created_by_user_id" = current_setting('app.current_user_id', true)) WITH CHECK ("created_by_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_copy_target_condition_baseline" (
  "billing_account_id" text NOT NULL,
  "target_id" uuid NOT NULL,
  "condition_id" text NOT NULL,
  "baseline_target_position_usdc" numeric(12,2) NOT NULL,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "captured_at_fill_id" text NOT NULL,
  PRIMARY KEY ("billing_account_id", "target_id", "condition_id"),
  CONSTRAINT "poly_copy_target_condition_baseline_usdc_non_negative" CHECK ("baseline_target_position_usdc" >= 0)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_wallet_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "billing_account_id" text NOT NULL REFERENCES "billing_accounts"("id") ON DELETE CASCADE,
  "created_by_user_id" text NOT NULL REFERENCES "users"("id"),
  "privy_wallet_id" text NOT NULL,
  "address" text NOT NULL,
  "chain_id" integer NOT NULL DEFAULT 137,
  "clob_api_key_ciphertext" bytea NOT NULL,
  "encryption_key_id" text NOT NULL,
  "allowance_state" jsonb,
  "custodial_consent_accepted_at" timestamptz NOT NULL,
  "custodial_consent_actor_kind" text NOT NULL,
  "custodial_consent_actor_id" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "trading_approvals_ready_at" timestamptz,
  "revoked_at" timestamptz,
  "revoked_by_user_id" text REFERENCES "users"("id"),
  "auto_wrap_consent_at" timestamptz,
  "auto_wrap_consent_actor_kind" text,
  "auto_wrap_consent_actor_id" text,
  "auto_wrap_floor_usdce_6dp" bigint NOT NULL DEFAULT 1000000,
  "auto_wrap_revoked_at" timestamptz,
  CONSTRAINT "poly_wallet_connections_address_shape" CHECK ("address" ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT "poly_wallet_connections_privy_wallet_id_nonempty" CHECK (char_length("privy_wallet_id") > 0),
  CONSTRAINT "poly_wallet_connections_consent_actor_kind" CHECK ("custodial_consent_actor_kind" IN ('user', 'agent')),
  CONSTRAINT "poly_wallet_connections_auto_wrap_consent_actor_kind" CHECK ("auto_wrap_consent_actor_kind" IS NULL OR "auto_wrap_consent_actor_kind" IN ('user', 'agent')),
  CONSTRAINT "poly_wallet_connections_auto_wrap_consent_trio" CHECK (("auto_wrap_consent_at" IS NULL AND "auto_wrap_consent_actor_kind" IS NULL AND "auto_wrap_consent_actor_id" IS NULL) OR ("auto_wrap_consent_at" IS NOT NULL AND "auto_wrap_consent_actor_kind" IS NOT NULL AND "auto_wrap_consent_actor_id" IS NOT NULL)),
  CONSTRAINT "poly_wallet_connections_auto_wrap_floor_positive" CHECK ("auto_wrap_floor_usdce_6dp" > 0)
);--> statement-breakpoint

ALTER TABLE "poly_wallet_connections" ADD COLUMN IF NOT EXISTS "trading_approvals_ready_at" timestamptz;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD COLUMN IF NOT EXISTS "auto_wrap_consent_at" timestamptz;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD COLUMN IF NOT EXISTS "auto_wrap_consent_actor_kind" text;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD COLUMN IF NOT EXISTS "auto_wrap_consent_actor_id" text;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD COLUMN IF NOT EXISTS "auto_wrap_floor_usdce_6dp" bigint NOT NULL DEFAULT 1000000;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD COLUMN IF NOT EXISTS "auto_wrap_revoked_at" timestamptz;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poly_wallet_connections_tenant_active_idx" ON "poly_wallet_connections"("billing_account_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poly_wallet_connections_address_chain_active_idx" ON "poly_wallet_connections"("chain_id", "address") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_wallet_connections_created_by_user_idx" ON "poly_wallet_connections"("created_by_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_wallet_connections_trading_ready_idx" ON "poly_wallet_connections"("billing_account_id") WHERE "revoked_at" IS NULL AND "trading_approvals_ready_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_wallet_connections_auto_wrap_eligible_idx" ON "poly_wallet_connections"("billing_account_id") WHERE "revoked_at" IS NULL AND "auto_wrap_consent_at" IS NOT NULL AND "auto_wrap_revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_wallet_connections";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "poly_wallet_connections" USING (EXISTS (SELECT 1 FROM "billing_accounts" ba WHERE ba."id" = "poly_wallet_connections"."billing_account_id" AND ba."owner_user_id" = current_setting('app.current_user_id', true))) WITH CHECK (EXISTS (SELECT 1 FROM "billing_accounts" ba WHERE ba."id" = "poly_wallet_connections"."billing_account_id" AND ba."owner_user_id" = current_setting('app.current_user_id', true)));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_wallet_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "billing_account_id" text NOT NULL REFERENCES "billing_accounts"("id") ON DELETE CASCADE,
  "wallet_connection_id" uuid NOT NULL REFERENCES "poly_wallet_connections"("id") ON DELETE CASCADE,
  "created_by_user_id" text NOT NULL REFERENCES "users"("id"),
  "scopes" text[] NOT NULL,
  "per_order_usdc_cap" numeric(10,2) NOT NULL,
  "daily_usdc_cap" numeric(10,2) NOT NULL,
  "hourly_fills_cap" integer NOT NULL,
  "expires_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  "revoked_by_user_id" text REFERENCES "users"("id"),
  CONSTRAINT "poly_wallet_grants_scopes_nonempty" CHECK (array_length("scopes", 1) > 0),
  CONSTRAINT "poly_wallet_grants_per_order_cap_positive" CHECK ("per_order_usdc_cap" > 0),
  CONSTRAINT "poly_wallet_grants_daily_cap_positive" CHECK ("daily_usdc_cap" > 0),
  CONSTRAINT "poly_wallet_grants_hourly_fills_cap_positive" CHECK ("hourly_fills_cap" > 0),
  CONSTRAINT "poly_wallet_grants_daily_ge_per_order" CHECK ("daily_usdc_cap" >= "per_order_usdc_cap")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "poly_wallet_grants_active_idx" ON "poly_wallet_grants"("billing_account_id", "created_at" DESC) WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_wallet_grants_connection_idx" ON "poly_wallet_grants"("wallet_connection_id") WHERE "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_wallet_grants_created_by_user_idx" ON "poly_wallet_grants"("created_by_user_id");--> statement-breakpoint
ALTER TABLE "poly_wallet_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_wallet_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_wallet_grants";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "poly_wallet_grants" USING (EXISTS (SELECT 1 FROM "billing_accounts" ba WHERE ba."id" = "poly_wallet_grants"."billing_account_id" AND ba."owner_user_id" = current_setting('app.current_user_id', true))) WITH CHECK (EXISTS (SELECT 1 FROM "billing_accounts" ba WHERE ba."id" = "poly_wallet_grants"."billing_account_id" AND ba."owner_user_id" = current_setting('app.current_user_id', true)));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_redeem_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "funder_address" text NOT NULL,
  "condition_id" text NOT NULL,
  "position_id" text NOT NULL,
  "outcome_index" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "flavor" text NOT NULL,
  "index_set" jsonb NOT NULL,
  "collateral_token" text NOT NULL DEFAULT '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  "expected_shares" text NOT NULL,
  "expected_payout_usdc" text NOT NULL,
  "tx_hashes" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "attempt_count" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "error_class" text,
  "lifecycle_state" text NOT NULL DEFAULT 'unresolved',
  "receipt_burn_observed" boolean,
  "submitted_at_block" bigint,
  "enqueued_at" timestamptz NOT NULL DEFAULT now(),
  "submitted_at" timestamptz,
  "confirmed_at" timestamptz,
  "abandoned_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "poly_redeem_jobs_funder_address_shape" CHECK ("funder_address" ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT "poly_redeem_jobs_condition_id_shape" CHECK ("condition_id" ~ '^0x[a-fA-F0-9]{64}$'),
  CONSTRAINT "poly_redeem_jobs_status_shape" CHECK ("status" IN ('pending', 'claimed', 'submitted', 'confirmed', 'failed_transient', 'abandoned', 'skipped')),
  CONSTRAINT "poly_redeem_jobs_flavor_shape" CHECK ("flavor" IN ('binary', 'multi-outcome', 'neg-risk-parent', 'neg-risk-adapter')),
  CONSTRAINT "poly_redeem_jobs_collateral_token_shape" CHECK ("collateral_token" ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT "poly_redeem_jobs_error_class_shape" CHECK ("error_class" IS NULL OR "error_class" IN ('transient_exhausted', 'malformed')),
  CONSTRAINT "poly_redeem_jobs_lifecycle_state_shape" CHECK ("lifecycle_state" IN ('unresolved', 'open', 'closing', 'closed', 'resolving', 'winner', 'redeem_pending', 'redeemed', 'loser', 'dust', 'abandoned'))
);--> statement-breakpoint

ALTER TABLE "poly_redeem_jobs" ADD COLUMN IF NOT EXISTS "collateral_token" text NOT NULL DEFAULT '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poly_redeem_jobs_funder_condition_uq" ON "poly_redeem_jobs"("funder_address", "condition_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_redeem_jobs_pending_idx" ON "poly_redeem_jobs"("enqueued_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_redeem_jobs_submitted_finality_idx" ON "poly_redeem_jobs"("submitted_at_block") WHERE "status" = 'submitted';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_subscription_cursors" (
  "subscription_id" text PRIMARY KEY NOT NULL,
  "last_processed_block" bigint NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_trader_wallets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wallet_address" text NOT NULL,
  "kind" text NOT NULL,
  "label" text NOT NULL,
  "active_for_research" boolean NOT NULL DEFAULT true,
  "first_observed_at" timestamptz DEFAULT now(),
  "disabled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "poly_trader_wallets_wallet_shape" CHECK ("wallet_address" ~ '^0x[a-fA-F0-9]{40}$'),
  CONSTRAINT "poly_trader_wallets_kind_check" CHECK ("kind" IN ('copy_target','cogni_wallet'))
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "poly_trader_wallets_wallet_address_idx" ON "poly_trader_wallets"("wallet_address");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_trader_wallets_observe_idx" ON "poly_trader_wallets"("active_for_research", "disabled_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_trader_ingestion_cursors" (
  "trader_wallet_id" uuid NOT NULL REFERENCES "poly_trader_wallets"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "last_seen_at" timestamptz,
  "last_seen_native_id" text,
  "last_success_at" timestamptz,
  "last_error_at" timestamptz,
  "status" text NOT NULL DEFAULT 'pending',
  "error_message" text,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("trader_wallet_id", "source"),
  CONSTRAINT "poly_trader_ingestion_cursors_source_check" CHECK ("source" IN ('data-api','data-api-trades','data-api-positions','clob-ws')),
  CONSTRAINT "poly_trader_ingestion_cursors_status_check" CHECK ("status" IN ('pending','ok','partial','stale','error'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "poly_trader_ingestion_cursors_status_idx" ON "poly_trader_ingestion_cursors"("status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_trader_fills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trader_wallet_id" uuid NOT NULL REFERENCES "poly_trader_wallets"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "native_id" text NOT NULL,
  "condition_id" text NOT NULL,
  "token_id" text NOT NULL,
  "side" text NOT NULL,
  "price" numeric(18,8) NOT NULL,
  "shares" numeric(20,8) NOT NULL,
  "size_usdc" numeric(20,8) NOT NULL,
  "tx_hash" text,
  "observed_at" timestamptz NOT NULL,
  "raw" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "poly_trader_fills_source_check" CHECK ("source" IN ('data-api','clob-ws')),
  CONSTRAINT "poly_trader_fills_side_check" CHECK ("side" IN ('BUY','SELL')),
  CONSTRAINT "poly_trader_fills_price_positive" CHECK ("price" > 0),
  CONSTRAINT "poly_trader_fills_shares_positive" CHECK ("shares" > 0),
  CONSTRAINT "poly_trader_fills_size_positive" CHECK ("size_usdc" > 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "poly_trader_fills_trader_source_native_idx" ON "poly_trader_fills"("trader_wallet_id", "source", "native_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_trader_fills_trader_observed_idx" ON "poly_trader_fills"("trader_wallet_id", "observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_trader_fills_market_token_idx" ON "poly_trader_fills"("condition_id", "token_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_trader_position_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "trader_wallet_id" uuid NOT NULL REFERENCES "poly_trader_wallets"("id") ON DELETE CASCADE,
  "condition_id" text NOT NULL,
  "token_id" text NOT NULL,
  "shares" numeric(20,8) NOT NULL,
  "cost_basis_usdc" numeric(20,8) NOT NULL,
  "current_value_usdc" numeric(20,8) NOT NULL,
  "avg_price" numeric(18,8) NOT NULL,
  "content_hash" text NOT NULL,
  "captured_at" timestamptz NOT NULL DEFAULT now(),
  "raw" jsonb,
  CONSTRAINT "poly_trader_position_snapshots_shares_nonnegative" CHECK ("shares" >= 0),
  CONSTRAINT "poly_trader_position_snapshots_cost_nonnegative" CHECK ("cost_basis_usdc" >= 0),
  CONSTRAINT "poly_trader_position_snapshots_value_nonnegative" CHECK ("current_value_usdc" >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "poly_trader_position_snapshots_hash_idx" ON "poly_trader_position_snapshots"("trader_wallet_id", "condition_id", "token_id", "content_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_trader_position_snapshots_latest_idx" ON "poly_trader_position_snapshots"("trader_wallet_id", "captured_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_trader_current_positions" (
  "trader_wallet_id" uuid NOT NULL REFERENCES "poly_trader_wallets"("id") ON DELETE CASCADE,
  "condition_id" text NOT NULL,
  "token_id" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "shares" numeric(20,8) NOT NULL,
  "cost_basis_usdc" numeric(20,8) NOT NULL,
  "current_value_usdc" numeric(20,8) NOT NULL,
  "avg_price" numeric(18,8) NOT NULL,
  "content_hash" text NOT NULL,
  "last_observed_at" timestamptz NOT NULL DEFAULT now(),
  "first_observed_at" timestamptz NOT NULL DEFAULT now(),
  "raw" jsonb,
  PRIMARY KEY ("trader_wallet_id", "condition_id", "token_id"),
  CONSTRAINT "poly_trader_current_positions_shares_nonnegative" CHECK ("shares" >= 0),
  CONSTRAINT "poly_trader_current_positions_cost_nonnegative" CHECK ("cost_basis_usdc" >= 0),
  CONSTRAINT "poly_trader_current_positions_value_nonnegative" CHECK ("current_value_usdc" >= 0)
);--> statement-breakpoint

ALTER TABLE "poly_trader_current_positions" ADD COLUMN IF NOT EXISTS "first_observed_at" timestamptz NOT NULL DEFAULT now();--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_trader_current_positions_active_idx" ON "poly_trader_current_positions"("trader_wallet_id", "active", "current_value_usdc");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_trader_current_positions_market_idx" ON "poly_trader_current_positions"("condition_id", "token_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_copy_trade_attribution" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "target_trader_wallet_id" uuid NOT NULL REFERENCES "poly_trader_wallets"("id") ON DELETE CASCADE,
  "cogni_trader_wallet_id" uuid REFERENCES "poly_trader_wallets"("id") ON DELETE SET NULL,
  "target_fill_id" uuid REFERENCES "poly_trader_fills"("id") ON DELETE SET NULL,
  "cogni_fill_id" uuid REFERENCES "poly_trader_fills"("id") ON DELETE SET NULL,
  "copy_trade_target_id" uuid,
  "copy_trade_fill_id" text,
  "copy_trade_decision_id" uuid,
  "condition_id" text NOT NULL,
  "token_id" text NOT NULL,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "target_vwap" numeric(18,8),
  "cogni_vwap" numeric(18,8),
  "target_size_usdc" numeric(20,8),
  "cogni_size_usdc" numeric(20,8),
  "window_start" timestamptz NOT NULL,
  "window_end" timestamptz NOT NULL,
  "computed_at" timestamptz NOT NULL DEFAULT now(),
  "raw" jsonb,
  CONSTRAINT "poly_copy_trade_attribution_status_check" CHECK ("status" IN ('copied','partial','missed','resting','skipped','error','no_response_yet'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "poly_copy_trade_attribution_target_window_idx" ON "poly_copy_trade_attribution"("target_trader_wallet_id", "window_start", "window_end");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_copy_trade_attribution_market_idx" ON "poly_copy_trade_attribution"("condition_id", "token_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_trader_user_pnl_points" (
  "trader_wallet_id" uuid NOT NULL REFERENCES "poly_trader_wallets"("id") ON DELETE CASCADE,
  "fidelity" text NOT NULL,
  "ts" timestamptz NOT NULL,
  "pnl_usdc" numeric(20,8) NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("trader_wallet_id", "fidelity", "ts"),
  CONSTRAINT "poly_trader_user_pnl_points_fidelity_check" CHECK ("fidelity" IN ('1h','1d'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "poly_trader_user_pnl_points_read_idx" ON "poly_trader_user_pnl_points"("trader_wallet_id", "fidelity", "ts");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_market_outcomes" (
  "condition_id" text NOT NULL,
  "token_id" text NOT NULL,
  "outcome" text NOT NULL,
  "payout" numeric(18,8),
  "resolved_at" timestamptz,
  "raw" jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("condition_id", "token_id"),
  CONSTRAINT "poly_market_outcomes_outcome_check" CHECK ("outcome" IN ('winner','loser','unknown'))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_market_metadata" (
  "condition_id" text PRIMARY KEY,
  "event_title" text,
  "event_slug" text,
  "market_title" text,
  "market_slug" text,
  "end_date" timestamptz,
  "raw" jsonb,
  "fetched_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "poly_market_metadata_event_slug_idx" ON "poly_market_metadata"("event_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poly_market_metadata_end_date_idx" ON "poly_market_metadata"("end_date");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "poly_market_price_history" (
  "asset" text NOT NULL,
  "fidelity" text NOT NULL,
  "ts" timestamptz NOT NULL,
  "price" numeric(18,8) NOT NULL,
  "observed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("asset", "fidelity", "ts"),
  CONSTRAINT "poly_market_price_history_fidelity_check" CHECK ("fidelity" IN ('1h','1d'))
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "poly_market_price_history_read_idx" ON "poly_market_price_history"("asset", "fidelity", "ts");--> statement-breakpoint

INSERT INTO "poly_trader_wallets" ("wallet_address", "kind", "label", "active_for_research")
VALUES
  ('0x2005d16a84ceefa912d4e380cd32e7ff827875ea', 'copy_target', 'RN1', true),
  ('0x204f72f35326db932158cba6adff0b9a1da95e14', 'copy_target', 'swisstony', true)
ON CONFLICT ("wallet_address") DO UPDATE SET
  "kind" = EXCLUDED."kind",
  "label" = EXCLUDED."label",
  "active_for_research" = EXCLUDED."active_for_research",
  "disabled_at" = NULL,
  "updated_at" = now();
