CREATE TABLE "poly_top_wallet_stats" (
	"time_period" text NOT NULL,
	"order_by" text NOT NULL,
	"wallet_address" text NOT NULL,
	"rank" integer NOT NULL,
	"user_name" text DEFAULT '' NOT NULL,
	"volume_usdc" numeric(20, 8) NOT NULL,
	"pnl_usdc" numeric(20, 8) NOT NULL,
	"roi_pct" numeric(18, 8),
	"num_trades" integer DEFAULT 0 NOT NULL,
	"num_trades_capped" boolean DEFAULT false NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poly_top_wallet_stats_time_period_order_by_wallet_address_pk" PRIMARY KEY("time_period","order_by","wallet_address"),
	CONSTRAINT "poly_top_wallet_stats_time_period_check" CHECK ("poly_top_wallet_stats"."time_period" IN ('DAY','WEEK','MONTH','ALL')),
	CONSTRAINT "poly_top_wallet_stats_order_by_check" CHECK ("poly_top_wallet_stats"."order_by" IN ('PNL','VOL')),
	CONSTRAINT "poly_top_wallet_stats_wallet_shape" CHECK ("poly_top_wallet_stats"."wallet_address" ~ '^0x[a-fA-F0-9]{40}$'),
	CONSTRAINT "poly_top_wallet_stats_rank_positive" CHECK ("poly_top_wallet_stats"."rank" > 0)
);
--> statement-breakpoint
CREATE INDEX "poly_top_wallet_stats_board_rank_idx" ON "poly_top_wallet_stats" USING btree ("time_period","order_by","rank");