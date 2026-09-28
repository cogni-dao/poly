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
ALTER TABLE "claimant_liabilities" ADD CONSTRAINT "claimant_liabilities_source_epoch_id_epochs_id_fk" FOREIGN KEY ("source_epoch_id") REFERENCES "public"."epochs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimant_liabilities" ADD CONSTRAINT "claimant_liabilities_statement_id_epoch_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."epoch_statements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claimant_liabilities" ADD CONSTRAINT "claimant_liabilities_settled_revision_id_distribution_settlement_revisions_id_fk" FOREIGN KEY ("settled_revision_id") REFERENCES "public"."distribution_settlement_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_settlement_leaves" ADD CONSTRAINT "distribution_settlement_leaves_revision_id_distribution_settlement_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."distribution_settlement_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_settlement_revisions" ADD CONSTRAINT "distribution_settlement_revisions_previous_revision_id_distribution_settlement_revisions_id_fk" FOREIGN KEY ("previous_revision_id") REFERENCES "public"."distribution_settlement_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "claimant_liabilities_source_claimant_unique" ON "claimant_liabilities" USING btree ("source_epoch_id","claimant_key");--> statement-breakpoint
CREATE INDEX "claimant_liabilities_pending_stream_idx" ON "claimant_liabilities" USING btree ("node_id","scope_id") WHERE "claimant_liabilities"."settled_revision_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_leaves_revision_index_unique" ON "distribution_settlement_leaves" USING btree ("revision_id","leaf_index");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_leaves_revision_account_unique" ON "distribution_settlement_leaves" USING btree ("revision_id","account_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_stream_sequence_unique" ON "distribution_settlement_revisions" USING btree ("node_id","scope_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_previous_unique" ON "distribution_settlement_revisions" USING btree ("previous_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_genesis_unique" ON "distribution_settlement_revisions" USING btree ("node_id","scope_id") WHERE "distribution_settlement_revisions"."previous_revision_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "distribution_settlement_revisions_root_unique" ON "distribution_settlement_revisions" USING btree ("node_id","scope_id","merkle_root");
--> statement-breakpoint

-- Handwritten appendix: append-only settlement history and exactly-once liability state.
ALTER TABLE "claimant_liabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "claimant_liabilities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_settlement_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_settlement_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_settlement_leaves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_settlement_leaves" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_distribution_settlement_revision_insert() RETURNS trigger AS $$
DECLARE
  parent distribution_settlement_revisions%ROWTYPE;
BEGIN
  IF NEW.previous_revision_id IS NULL THEN
    IF NEW.sequence <> 1 THEN
      RAISE EXCEPTION 'genesis settlement revision must have sequence 1';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO parent
    FROM distribution_settlement_revisions
    WHERE id = NEW.previous_revision_id;
  IF NOT FOUND
    OR parent.node_id <> NEW.node_id
    OR parent.scope_id <> NEW.scope_id
    OR parent.sequence + 1 <> NEW.sequence
    OR parent.merkle_root <> NEW.previous_merkle_root
    OR parent.cumulative_total + NEW.mint_delta <> NEW.cumulative_total
    OR parent.chain_id <> NEW.chain_id
    OR lower(parent.token_address) <> lower(NEW.token_address)
    OR lower(parent.distributor_address) IS DISTINCT FROM lower(NEW.distributor_address)
  THEN
    RAISE EXCEPTION 'invalid settlement revision chain';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER distribution_settlement_revisions_validate_insert
  BEFORE INSERT ON "distribution_settlement_revisions"
  FOR EACH ROW EXECUTE FUNCTION validate_distribution_settlement_revision_insert();--> statement-breakpoint

CREATE TRIGGER distribution_settlement_revisions_append_only
  BEFORE UPDATE OR DELETE ON "distribution_settlement_revisions"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint

CREATE TRIGGER distribution_settlement_leaves_append_only
  BEFORE UPDATE OR DELETE ON "distribution_settlement_leaves"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();--> statement-breakpoint

CREATE OR REPLACE FUNCTION validate_claimant_liability_insert() RETURNS trigger AS $$
DECLARE
  source_node_id uuid;
  source_scope_id uuid;
  source_statement_id uuid;
BEGIN
  IF NEW.settled_revision_id IS NOT NULL THEN
    RAISE EXCEPTION 'claimant liability must be inserted pending';
  END IF;

  SELECT e.node_id, e.scope_id, s.id
    INTO source_node_id, source_scope_id, source_statement_id
    FROM epochs e
    JOIN epoch_statements s
      ON s.epoch_id = e.id
      AND s.id = NEW.statement_id
      AND s.node_id = e.node_id
    WHERE e.id = NEW.source_epoch_id;
  IF NOT FOUND
    OR source_node_id <> NEW.node_id
    OR source_scope_id <> NEW.scope_id
    OR source_statement_id <> NEW.statement_id
  THEN
    RAISE EXCEPTION 'claimant liability source does not match its epoch statement';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER claimant_liabilities_validate_insert
  BEFORE INSERT ON "claimant_liabilities"
  FOR EACH ROW EXECUTE FUNCTION validate_claimant_liability_insert();--> statement-breakpoint

CREATE OR REPLACE FUNCTION claimant_liability_settle_once() RETURNS trigger AS $$
DECLARE
  revision_node_id uuid;
  revision_scope_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE not allowed on claimant_liabilities';
  END IF;

  IF OLD.node_id IS DISTINCT FROM NEW.node_id
    OR OLD.scope_id IS DISTINCT FROM NEW.scope_id
    OR OLD.source_epoch_id IS DISTINCT FROM NEW.source_epoch_id
    OR OLD.statement_id IS DISTINCT FROM NEW.statement_id
    OR OLD.claimant_key IS DISTINCT FROM NEW.claimant_key
    OR OLD.amount_atomic IS DISTINCT FROM NEW.amount_atomic
    OR OLD.receipt_ids_json IS DISTINCT FROM NEW.receipt_ids_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.settled_revision_id IS NOT NULL
    OR NEW.settled_revision_id IS NULL
  THEN
    RAISE EXCEPTION 'claimant liability is immutable except for one settlement transition';
  END IF;

  SELECT node_id, scope_id INTO revision_node_id, revision_scope_id
    FROM distribution_settlement_revisions
    WHERE id = NEW.settled_revision_id;
  IF NOT FOUND
    OR revision_node_id <> NEW.node_id
    OR revision_scope_id <> NEW.scope_id
  THEN
    RAISE EXCEPTION 'settlement revision must belong to the liability stream';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER claimant_liabilities_settle_once
  BEFORE UPDATE OR DELETE ON "claimant_liabilities"
  FOR EACH ROW EXECUTE FUNCTION claimant_liability_settle_once();
