CREATE TABLE "claimant_liabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"source_epoch_id" bigint NOT NULL,
	"statement_id" uuid NOT NULL,
	"claimant_key" text NOT NULL,
	"amount_atomic" numeric NOT NULL,
	"receipt_ids_json" jsonb NOT NULL,
	"settled_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claimant_liabilities_amount_positive" CHECK ("claimant_liabilities"."amount_atomic" > 0)
);
--> statement-breakpoint
ALTER TABLE "claimant_liabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claimant_liabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "distribution_settlement_leaves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"leaf_index" integer NOT NULL,
	"claimant_key" text NOT NULL,
	"account" text NOT NULL,
	"account_lower" text NOT NULL,
	"cumulative_amount" numeric NOT NULL,
	"delta_amount" numeric NOT NULL,
	"receipt_ids_json" jsonb NOT NULL,
	"leaf_hash" text NOT NULL,
	"proof_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_settlement_leaves_amounts_nonnegative" CHECK ("distribution_settlement_leaves"."cumulative_amount" >= 0 AND "distribution_settlement_leaves"."delta_amount" >= 0 AND "distribution_settlement_leaves"."delta_amount" <= "distribution_settlement_leaves"."cumulative_amount")
);
--> statement-breakpoint
ALTER TABLE "distribution_settlement_leaves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_settlement_leaves" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "distribution_settlement_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"previous_revision_id" uuid,
	"previous_merkle_root" text,
	"distribution_id" text NOT NULL,
	"statement_hash" text NOT NULL,
	"merkle_root" text NOT NULL,
	"chain_id" bigint NOT NULL,
	"token_address" text NOT NULL,
	"distributor_address" text,
	"mint_delta" numeric NOT NULL,
	"cumulative_total" numeric NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_settlement_revisions_sequence_positive" CHECK ("distribution_settlement_revisions"."sequence" > 0),
	CONSTRAINT "distribution_settlement_revisions_amounts_nonnegative" CHECK ("distribution_settlement_revisions"."mint_delta" >= 0 AND "distribution_settlement_revisions"."cumulative_total" >= 0),
	CONSTRAINT "distribution_settlement_revisions_chain_shape" CHECK (("distribution_settlement_revisions"."previous_revision_id" IS NULL AND "distribution_settlement_revisions"."previous_merkle_root" IS NULL AND "distribution_settlement_revisions"."sequence" = 1) OR ("distribution_settlement_revisions"."previous_revision_id" IS NOT NULL AND "distribution_settlement_revisions"."previous_merkle_root" IS NOT NULL AND "distribution_settlement_revisions"."sequence" > 1))
);
--> statement-breakpoint
ALTER TABLE "distribution_settlement_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_settlement_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "epoch_distribution_leaves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"manifest_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"leaf_index" integer NOT NULL,
	"claimant_key" text NOT NULL,
	"account" text NOT NULL,
	"account_lower" text NOT NULL,
	"amount" numeric NOT NULL,
	"leaf_hash" text NOT NULL,
	"proof_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epoch_distribution_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"epoch_id" bigint NOT NULL,
	"distribution_id" text NOT NULL,
	"statement_hash" text NOT NULL,
	"merkle_root" text NOT NULL,
	"chain_id" bigint NOT NULL,
	"token_address" text NOT NULL,
	"distribution_amount" numeric NOT NULL,
	"total_allocated" numeric NOT NULL,
	"distributor_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_signin_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_signin_challenges_nonce_hash_unique" UNIQUE("nonce_hash")
);
--> statement-breakpoint
ALTER TABLE "identity_signin_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_signin_challenges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claimant_liabilities" ADD CONSTRAINT "claimant_liabilities_source_epoch_id_epochs_id_fk" FOREIGN KEY ("source_epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimant_liabilities" ADD CONSTRAINT "claimant_liabilities_statement_id_epoch_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."epoch_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimant_liabilities" ADD CONSTRAINT "claimant_liabilities_settled_revision_id_distribution_settlement_revisions_id_fk" FOREIGN KEY ("settled_revision_id") REFERENCES "public"."distribution_settlement_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_settlement_leaves" ADD CONSTRAINT "distribution_settlement_leaves_revision_id_distribution_settlement_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."distribution_settlement_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_settlement_revisions" ADD CONSTRAINT "distribution_settlement_revisions_previous_revision_id_distribution_settlement_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."distribution_settlement_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_distribution_leaves" ADD CONSTRAINT "epoch_distribution_leaves_manifest_id_epoch_distribution_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."epoch_distribution_manifests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_distribution_leaves" ADD CONSTRAINT "epoch_distribution_leaves_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epoch_distribution_manifests" ADD CONSTRAINT "epoch_distribution_manifests_epoch_id_epochs_id_fk" FOREIGN KEY ("epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claimant_liabilities_source_claimant_unique" ON "claimant_liabilities" USING btree ("source_epoch_id","claimant_key");--> statement-breakpoint
CREATE INDEX "claimant_liabilities_pending_stream_idx" ON "claimant_liabilities" USING btree ("node_id","scope_id") WHERE "claimant_liabilities"."settled_revision_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_leaves_revision_index_unique" ON "distribution_settlement_leaves" USING btree ("revision_id","leaf_index");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_leaves_revision_account_unique" ON "distribution_settlement_leaves" USING btree ("revision_id","account_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_stream_sequence_unique" ON "distribution_settlement_revisions" USING btree ("node_id","scope_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_previous_unique" ON "distribution_settlement_revisions" USING btree ("previous_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_genesis_unique" ON "distribution_settlement_revisions" USING btree ("node_id","scope_id") WHERE "distribution_settlement_revisions"."previous_revision_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_root_unique" ON "distribution_settlement_revisions" USING btree ("node_id","scope_id","merkle_root");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_distribution_leaves_manifest_index_unique" ON "epoch_distribution_leaves" USING btree ("manifest_id","leaf_index");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_distribution_leaves_manifest_account_unique" ON "epoch_distribution_leaves" USING btree ("manifest_id","account_lower");--> statement-breakpoint
CREATE INDEX "epoch_distribution_leaves_epoch_idx" ON "epoch_distribution_leaves" USING btree ("epoch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "epoch_distribution_manifests_node_scope_epoch_unique" ON "epoch_distribution_manifests" USING btree ("node_id","scope_id","epoch_id");--> statement-breakpoint
CREATE INDEX "epoch_distribution_manifests_epoch_idx" ON "epoch_distribution_manifests" USING btree ("epoch_id");--> statement-breakpoint
CREATE INDEX "identity_signin_challenges_expires_at_idx" ON "identity_signin_challenges" USING btree ("expires_at");