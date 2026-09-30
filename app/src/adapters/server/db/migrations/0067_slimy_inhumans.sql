CREATE TABLE "poly_trader_fill_rollup_cursors" (
	"trader_wallet_id" uuid PRIMARY KEY NOT NULL,
	"last_created_at" timestamp with time zone DEFAULT 'epoch'::timestamptz NOT NULL,
	"last_fill_id" uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid NOT NULL,
	"rolled_fill_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poly_trader_fill_rollups_daily" (
	"trader_wallet_id" uuid NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"day" date NOT NULL,
	"fill_count" integer NOT NULL,
	"buy_count" integer NOT NULL,
	"sell_count" integer NOT NULL,
	"buy_usdc" numeric(20, 8) NOT NULL,
	"sell_usdc" numeric(20, 8) NOT NULL,
	"buy_shares" numeric(20, 8) NOT NULL,
	"sell_shares" numeric(20, 8) NOT NULL,
	"first_buy_observed_at" timestamp with time zone,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poly_trader_fill_rollups_daily_trader_wallet_id_condition_id_token_id_day_pk" PRIMARY KEY("trader_wallet_id","condition_id","token_id","day"),
	CONSTRAINT "poly_trader_fill_rollups_daily_counts_nonnegative" CHECK ("poly_trader_fill_rollups_daily"."fill_count" >= 0 AND "poly_trader_fill_rollups_daily"."buy_count" >= 0 AND "poly_trader_fill_rollups_daily"."sell_count" >= 0),
	CONSTRAINT "poly_trader_fill_rollups_daily_sums_nonnegative" CHECK ("poly_trader_fill_rollups_daily"."buy_usdc" >= 0 AND "poly_trader_fill_rollups_daily"."sell_usdc" >= 0 AND "poly_trader_fill_rollups_daily"."buy_shares" >= 0 AND "poly_trader_fill_rollups_daily"."sell_shares" >= 0)
);
--> statement-breakpoint
ALTER TABLE "poly_trader_fill_rollup_cursors" ADD CONSTRAINT "poly_trader_fill_rollup_cursors_trader_wallet_id_poly_trader_wallets_id_fk" FOREIGN KEY ("trader_wallet_id") REFERENCES "public"."poly_trader_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_trader_fill_rollups_daily" ADD CONSTRAINT "poly_trader_fill_rollups_daily_trader_wallet_id_poly_trader_wallets_id_fk" FOREIGN KEY ("trader_wallet_id") REFERENCES "public"."poly_trader_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "poly_trader_fill_rollups_daily_wallet_day_idx" ON "poly_trader_fill_rollups_daily" USING btree ("trader_wallet_id","day");--> statement-breakpoint
CREATE INDEX "poly_trader_fill_rollups_daily_wallet_token_idx" ON "poly_trader_fill_rollups_daily" USING btree ("trader_wallet_id","token_id");--> statement-breakpoint
CREATE INDEX "poly_trader_fills_trader_created_idx" ON "poly_trader_fills" USING btree ("trader_wallet_id","created_at","id");