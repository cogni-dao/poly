-- Migration 0029 recreated `poly_copy_trade_fills` with an anonymous
-- `PRIMARY KEY (target_id, fill_id)` clause, so Postgres assigned the
-- default name `poly_copy_trade_fills_pkey` — NOT the explicit name
-- the drizzle snapshot tracks. The DROP IF EXISTS handles both shapes:
-- the current `_pkey` form lands on candidate-a; the older explicit form
-- (if any environment still holds it from a 0027-only deploy) is also
-- dropped cleanly. The new explicit name pins the constraint going forward.
ALTER TABLE "poly_copy_trade_fills" DROP CONSTRAINT IF EXISTS "poly_copy_trade_fills_pkey";--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" DROP CONSTRAINT IF EXISTS "poly_copy_trade_fills_target_id_fill_id_pk";--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD CONSTRAINT "poly_copy_trade_fills_billing_account_id_target_id_fill_id_pk" PRIMARY KEY("billing_account_id","target_id","fill_id");