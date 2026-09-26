DROP INDEX "poly_market_price_history_read_idx";--> statement-breakpoint
DROP INDEX "poly_trader_user_pnl_points_read_idx";--> statement-breakpoint
CREATE INDEX "poly_copy_trade_fills_billing_observed_idx" ON "poly_copy_trade_fills" USING btree ("billing_account_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "poly_copy_trade_fills_status_created_idx" ON "poly_copy_trade_fills" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "poly_trader_current_positions_active_observed_idx" ON "poly_trader_current_positions" USING btree ("last_observed_at") WHERE "poly_trader_current_positions"."active" = true;--> statement-breakpoint
CREATE INDEX "poly_trader_fills_observed_at_idx" ON "poly_trader_fills" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "poly_trader_position_snapshots_market_latest_idx" ON "poly_trader_position_snapshots" USING btree ("condition_id","trader_wallet_id","token_id","captured_at" DESC NULLS LAST);