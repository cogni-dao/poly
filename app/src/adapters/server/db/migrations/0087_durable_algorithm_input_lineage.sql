-- bug.5035 — immutable decision-time planner evidence. The content address is
-- tenant-scoped; assignment/correlation remain event identity on fill rows.
CREATE TABLE "poly_algorithm_input_snapshots" (
  "billing_account_id" text NOT NULL,
  "input_snapshot_id" text NOT NULL,
  "created_by_user_id" text NOT NULL,
  "algorithm_id" text NOT NULL,
  "input_contract_version" text NOT NULL,
  "canonical_input" jsonb NOT NULL,
  "quality" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "poly_algorithm_input_snapshots_billing_snapshot_pk" PRIMARY KEY("billing_account_id", "input_snapshot_id"),
  CONSTRAINT "poly_algorithm_input_snapshots_id_valid" CHECK ("input_snapshot_id" ~ '^sha256:[a-f0-9]{64}$')
);--> statement-breakpoint
ALTER TABLE "poly_algorithm_input_snapshots" ADD CONSTRAINT "poly_algorithm_input_snapshots_billing_account_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_algorithm_input_snapshots" ADD CONSTRAINT "poly_algorithm_input_snapshots_created_by_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "poly_algorithm_input_snapshots_created_idx" ON "poly_algorithm_input_snapshots" ("billing_account_id", "created_at" DESC);--> statement-breakpoint
ALTER TABLE "poly_algorithm_input_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_algorithm_input_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "poly_algorithm_input_snapshots_select" ON "poly_algorithm_input_snapshots"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_algorithm_input_snapshots"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
    )
  );--> statement-breakpoint
CREATE POLICY "poly_algorithm_input_snapshots_insert" ON "poly_algorithm_input_snapshots"
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  );--> statement-breakpoint
ALTER TABLE "poly_position_gap_runs" ADD COLUMN "input_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "poly_position_gap_runs" ADD CONSTRAINT "poly_position_gap_runs_input_snapshot_fk"
  FOREIGN KEY ("billing_account_id", "input_snapshot_id")
  REFERENCES "public"."poly_algorithm_input_snapshots"("billing_account_id", "input_snapshot_id")
  ON DELETE restrict ON UPDATE no action;
