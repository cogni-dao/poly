ALTER TABLE "poly_copy_trade_targets" DROP CONSTRAINT "poly_copy_trade_targets_target_scale_range";--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN "mirror_capital_alloc_usdc" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" DROP COLUMN "target_scale";--> statement-breakpoint
-- 2026-05-18 locked design: position_gap rows MUST carry an explicit alloc.
-- Backfill the in-flight position_gap tenants (cand-a/RN1-GAP, cand-a/GAP,
-- preview/swiss-gap, plus any others added before this commit lands) with
-- $5.00 — matches the existing mirror_max_usdc_per_trade default on those
-- rows. Operators PATCH per-target post-migration to their preferred alloc.
-- Runs BEFORE the requires_alloc CHECK below so the CHECK never sees a
-- violating row.
--
-- RLS NOTE: `poly_copy_trade_targets` has `FORCE ROW LEVEL SECURITY`, so the
-- migrator (running as table owner `app_user` with no `app.current_user_id`
-- set) is RLS-clamped to zero rows. Toggle FORCE off for the UPDATE only,
-- then restore — RLS itself stays enabled for app traffic. CHECK validation
-- below runs at the table level and isn't RLS-clamped, so without this
-- toggle the UPDATE affects 0 rows and the subsequent
-- `position_gap_requires_alloc` CHECK fails against unupdated existing rows.
ALTER TABLE "poly_copy_trade_targets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "poly_copy_trade_targets"
SET "mirror_capital_alloc_usdc" = 5.00
WHERE "sizing_policy_kind" = 'position_gap'
  AND "mirror_capital_alloc_usdc" IS NULL;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_capital_alloc_positive" CHECK ("poly_copy_trade_targets"."mirror_capital_alloc_usdc" IS NULL OR "poly_copy_trade_targets"."mirror_capital_alloc_usdc" > 0);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_position_gap_requires_alloc" CHECK ("poly_copy_trade_targets"."sizing_policy_kind" <> 'position_gap' OR "poly_copy_trade_targets"."mirror_capital_alloc_usdc" IS NOT NULL);