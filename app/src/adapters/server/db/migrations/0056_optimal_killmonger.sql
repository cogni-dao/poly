ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "price" numeric(18, 8);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "shares" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "fees_usdc" numeric(20, 8);--> statement-breakpoint
CREATE INDEX "poly_copy_trade_fills_pnl_idx" ON "poly_copy_trade_fills" USING btree ("billing_account_id","target_id","market_id","mode","status");