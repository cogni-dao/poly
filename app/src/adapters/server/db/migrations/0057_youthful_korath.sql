-- task.5014 — position_gap rewrite: range-relative + forward-only baseline.
-- See docs/research/poly/range-relative-mirror-2026-05-26.md for design.
-- Tenant reset (deactivate old position_gap matrix tenants, register new ones)
-- is an OPERATOR ACTION via the copy-trade-targets API, NOT a migration step.

CREATE TABLE "poly_copy_target_condition_baseline" (
	"billing_account_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"condition_id" text NOT NULL,
	"baseline_target_position_usdc" numeric(12, 2) NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at_fill_id" text NOT NULL,
	CONSTRAINT "poly_copy_target_condition_baseline_billing_account_id_target_id_condition_id_pk" PRIMARY KEY("billing_account_id","target_id","condition_id"),
	CONSTRAINT "poly_copy_target_condition_baseline_usdc_non_negative" CHECK ("poly_copy_target_condition_baseline"."baseline_target_position_usdc" >= 0)
);
--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" DROP CONSTRAINT "poly_copy_trade_targets_capital_alloc_positive";--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" DROP CONSTRAINT "poly_copy_trade_targets_position_gap_requires_alloc";--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN "target_range_max_usdc" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN "mirror_max_alloc_per_condition_usdc" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN "mirror_activated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" DROP COLUMN "mirror_capital_alloc_usdc";--> statement-breakpoint

-- Disable any active `position_gap` rows so the new CHECK can apply. The
-- handoff's "operator action via existing API" plan is impossible in
-- practice — migration runs before the new code is reachable, and active
-- rows exist across owner accounts the deploy operator can't all
-- soft-delete. Disabling here preserves all data (only flips
-- `disabled_at`) and matches the design intent (legacy Σ-book-shaped rows
-- soft-deleted; operator POSTs fresh rows with the new knobs after deploy).
-- Idempotent — no-op on subsequent runs and on envs with no active
-- position_gap rows (e.g. prod today).
--
-- RLS NOTE: `poly_copy_trade_targets` has `FORCE ROW LEVEL SECURITY`
-- (migration 0029), so the migrator (no `app.current_user_id` set) is
-- RLS-clamped to zero rows by default — verified empirically on candidate-a
-- flights 1+2 of this PR, where the UPDATE matched 0 rows and the CHECK
-- below failed against unupdated rows. Toggle FORCE off for the UPDATE
-- only, then restore. Same pattern as migration 0055.
ALTER TABLE "poly_copy_trade_targets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "poly_copy_trade_targets"
  SET "disabled_at" = now()
  WHERE "sizing_policy_kind" = 'position_gap' AND "disabled_at" IS NULL;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_range_max_positive" CHECK ("poly_copy_trade_targets"."target_range_max_usdc" IS NULL OR "poly_copy_trade_targets"."target_range_max_usdc" > 0);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_alloc_per_condition_positive" CHECK ("poly_copy_trade_targets"."mirror_max_alloc_per_condition_usdc" IS NULL OR "poly_copy_trade_targets"."mirror_max_alloc_per_condition_usdc" > 0);--> statement-breakpoint
-- Grandfather disabled rows: legacy position_gap rows (running on the dropped
-- Σ-book scale) stay valid as long as they're soft-deleted. Operator switches
-- live tenants by disabling old rows + POSTing new ones via the API.
ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_position_gap_requires_range_knobs" CHECK ("poly_copy_trade_targets"."sizing_policy_kind" <> 'position_gap' OR "poly_copy_trade_targets"."disabled_at" IS NOT NULL OR ("poly_copy_trade_targets"."target_range_max_usdc" IS NOT NULL AND "poly_copy_trade_targets"."mirror_max_alloc_per_condition_usdc" IS NOT NULL));--> statement-breakpoint

-- RLS for poly_copy_target_condition_baseline — tenant isolation by
-- billing_account_id, mirrors migration 0031. Hand-authored because
-- drizzle-kit doesn't emit RLS.
ALTER TABLE "poly_copy_target_condition_baseline" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_copy_target_condition_baseline" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "tenant_isolation" ON "poly_copy_target_condition_baseline"
  USING (
    EXISTS (
      SELECT 1 FROM "billing_accounts" ba
      WHERE ba."id" = "poly_copy_target_condition_baseline"."billing_account_id"
        AND ba."owner_user_id" = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "billing_accounts" ba
      WHERE ba."id" = "poly_copy_target_condition_baseline"."billing_account_id"
        AND ba."owner_user_id" = current_setting('app.current_user_id', true)
    )
  );