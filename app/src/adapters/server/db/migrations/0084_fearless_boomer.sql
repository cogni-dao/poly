ALTER TABLE "poly_wallet_balance_snapshots" DROP CONSTRAINT "poly_wallet_balance_snapshots_pkey";--> statement-breakpoint
ALTER TABLE "poly_wallet_balance_snapshots" ADD CONSTRAINT "poly_wallet_balance_snapshots_billing_address_pk" PRIMARY KEY("billing_account_id","address");
