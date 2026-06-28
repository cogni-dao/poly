ALTER TABLE "poly_copy_trade_decisions" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_copy_trade_decisions" ADD CONSTRAINT "poly_copy_trade_decisions_mode_check" CHECK ("poly_copy_trade_decisions"."mode" IN ('live','paper'));--> statement-breakpoint
ALTER TABLE "poly_copy_trade_fills" ADD CONSTRAINT "poly_copy_trade_fills_mode_check" CHECK ("poly_copy_trade_fills"."mode" IN ('live','paper'));--> statement-breakpoint
ALTER TABLE "poly_copy_trade_targets" ADD CONSTRAINT "poly_copy_trade_targets_mode_check" CHECK ("poly_copy_trade_targets"."mode" IN ('live','paper'));