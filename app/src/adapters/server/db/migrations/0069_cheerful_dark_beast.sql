CREATE TABLE "poly_wallet_balance_snapshots" (
	"billing_account_id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"usdc_e" numeric(20, 8),
	"pusd" numeric(20, 8),
	"pol" numeric(30, 18),
	"status" text NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poly_wallet_balance_snapshots_address_shape" CHECK ("poly_wallet_balance_snapshots"."address" ~ '^0x[a-fA-F0-9]{40}$'),
	CONSTRAINT "poly_wallet_balance_snapshots_status_check" CHECK ("poly_wallet_balance_snapshots"."status" IN ('ok','partial','error')),
	CONSTRAINT "poly_wallet_balance_snapshots_nonnegative" CHECK (("poly_wallet_balance_snapshots"."usdc_e" IS NULL OR "poly_wallet_balance_snapshots"."usdc_e" >= 0) AND ("poly_wallet_balance_snapshots"."pusd" IS NULL OR "poly_wallet_balance_snapshots"."pusd" >= 0) AND ("poly_wallet_balance_snapshots"."pol" IS NULL OR "poly_wallet_balance_snapshots"."pol" >= 0)),
	CONSTRAINT "poly_wallet_balance_snapshots_status_values" CHECK (("poly_wallet_balance_snapshots"."status" = 'ok' AND num_nonnulls("poly_wallet_balance_snapshots"."usdc_e", "poly_wallet_balance_snapshots"."pusd", "poly_wallet_balance_snapshots"."pol") = 3) OR ("poly_wallet_balance_snapshots"."status" = 'partial' AND num_nonnulls("poly_wallet_balance_snapshots"."usdc_e", "poly_wallet_balance_snapshots"."pusd", "poly_wallet_balance_snapshots"."pol") BETWEEN 1 AND 2) OR ("poly_wallet_balance_snapshots"."status" = 'error' AND num_nonnulls("poly_wallet_balance_snapshots"."usdc_e", "poly_wallet_balance_snapshots"."pusd", "poly_wallet_balance_snapshots"."pol") = 0))
);
--> statement-breakpoint
ALTER TABLE "poly_wallet_balance_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_wallet_balance_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_wallet_balance_snapshots" ADD CONSTRAINT "poly_wallet_balance_snapshots_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "poly_wallet_balance_snapshots" AS PERMISSIVE FOR ALL TO public USING ("poly_wallet_balance_snapshots"."billing_account_id" IN (SELECT id FROM billing_accounts WHERE owner_user_id = current_setting('app.current_user_id', true))) WITH CHECK ("poly_wallet_balance_snapshots"."billing_account_id" IN (SELECT id FROM billing_accounts WHERE owner_user_id = current_setting('app.current_user_id', true)));
