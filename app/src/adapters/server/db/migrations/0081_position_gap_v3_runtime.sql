CREATE TABLE "poly_position_gap_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"cohort_key" text NOT NULL,
	"action_key" text NOT NULL,
	"kind" text NOT NULL,
	"related_buy_action_id" uuid,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"market_id" text NOT NULL,
	"outcome" text NOT NULL,
	"desired_shares" numeric(30, 12),
	"notional_usdc" numeric(20, 8),
	"limit_price" numeric(20, 10),
	"filled_shares" numeric(30, 12) DEFAULT '0' NOT NULL,
	"filled_usdc" numeric(20, 8) DEFAULT '0' NOT NULL,
	"planner_action" jsonb NOT NULL,
	"client_order_id" text,
	"order_id" text,
	"status" text DEFAULT 'reserved' NOT NULL,
	"venue_status" text,
	"venue_observed_at" timestamp with time zone,
	"error_code" text,
	"error_detail" text,
	"submit_started_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poly_position_gap_actions_kind_check" CHECK ("poly_position_gap_actions"."kind" IN ('buy','cancel')),
	CONSTRAINT "poly_position_gap_actions_status_check" CHECK ("poly_position_gap_actions"."status" IN ('reserved','ledgered','submitting','open','partial','filled','cancel_requested','canceled','rejected','ambiguous')),
	CONSTRAINT "poly_position_gap_actions_buy_shape_check" CHECK ("poly_position_gap_actions"."kind" <> 'buy' OR (
        "poly_position_gap_actions"."desired_shares" > 0
        AND "poly_position_gap_actions"."notional_usdc" > 0
        AND "poly_position_gap_actions"."limit_price" > 0
        AND "poly_position_gap_actions"."limit_price" < 1
        AND "poly_position_gap_actions"."client_order_id" IS NOT NULL
      )),
	CONSTRAINT "poly_position_gap_actions_filled_check" CHECK ("poly_position_gap_actions"."filled_shares" >= 0 AND "poly_position_gap_actions"."filled_usdc" >= 0)
);
--> statement-breakpoint
ALTER TABLE "poly_position_gap_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_position_gap_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "poly_position_gap_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"cohort_key" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_event_id" text,
	"source_config_revision" text,
	"source_snapshot_id" text NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"source_snapshot_as_of" timestamp with time zone NOT NULL,
	"source_provenance" jsonb NOT NULL,
	"created_run_id" uuid NOT NULL,
	"condition_id" text NOT NULL,
	"token_id" text NOT NULL,
	"market_id" text NOT NULL,
	"outcome" text NOT NULL,
	"target_delta_shares" numeric(30, 12) NOT NULL,
	"scale_at_creation" numeric(30, 18) NOT NULL,
	"allowed_mirror_shares" numeric(30, 12) NOT NULL,
	"initial_allowed_mirror_shares" numeric(30, 12) NOT NULL,
	"benchmark_target_vwap" numeric(20, 10) NOT NULL,
	"acquired_shares" numeric(30, 12) DEFAULT '0' NOT NULL,
	"open_order_shares" numeric(30, 12) DEFAULT '0' NOT NULL,
	"remaining_shares" numeric(30, 12) NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poly_position_gap_cohorts_source_kind_check" CHECK ("poly_position_gap_cohorts"."source_kind" IN ('activation','target_buy','config_increase')),
	CONSTRAINT "poly_position_gap_cohorts_status_check" CHECK ("poly_position_gap_cohorts"."status" IN ('available','resting','exhausted','reduced','over_target','resolved')),
	CONSTRAINT "poly_position_gap_cohorts_nonnegative_check" CHECK ("poly_position_gap_cohorts"."target_delta_shares" >= 0
        AND "poly_position_gap_cohorts"."scale_at_creation" >= 0
        AND "poly_position_gap_cohorts"."allowed_mirror_shares" >= 0
		AND "poly_position_gap_cohorts"."initial_allowed_mirror_shares" >= "poly_position_gap_cohorts"."allowed_mirror_shares"
        AND "poly_position_gap_cohorts"."benchmark_target_vwap" > 0
        AND "poly_position_gap_cohorts"."benchmark_target_vwap" < 1
        AND "poly_position_gap_cohorts"."acquired_shares" >= 0
        AND "poly_position_gap_cohorts"."open_order_shares" >= 0
        AND "poly_position_gap_cohorts"."remaining_shares" >= 0),
	CONSTRAINT "poly_position_gap_cohorts_accounting_check" CHECK ("poly_position_gap_cohorts"."remaining_shares" <= "poly_position_gap_cohorts"."allowed_mirror_shares")
);
--> statement-breakpoint
ALTER TABLE "poly_position_gap_cohorts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_position_gap_cohorts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "poly_position_gap_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"buy_action_id" uuid NOT NULL,
	"budget_notional_usdc" numeric(20, 8) NOT NULL,
	"executor_cash_guard_atomic" numeric(30, 0) NOT NULL,
	"cash_guard_source" text NOT NULL,
	"filled_cost_usdc" numeric(20, 8) DEFAULT '0' NOT NULL,
	"released_budget_usdc" numeric(20, 8) DEFAULT '0' NOT NULL,
	"released_cash_guard_atomic" numeric(30, 0) DEFAULT '0' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"release_reason" text,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poly_position_gap_reservations_state_check" CHECK ("poly_position_gap_reservations"."state" IN ('active','released')),
	CONSTRAINT "poly_position_gap_reservations_amounts_check" CHECK ("poly_position_gap_reservations"."budget_notional_usdc" > 0
        AND "poly_position_gap_reservations"."executor_cash_guard_atomic" > 0
        AND "poly_position_gap_reservations"."filled_cost_usdc" >= 0
        AND "poly_position_gap_reservations"."released_budget_usdc" >= 0
        AND "poly_position_gap_reservations"."released_budget_usdc" <= "poly_position_gap_reservations"."budget_notional_usdc"
        AND "poly_position_gap_reservations"."released_cash_guard_atomic" >= 0
        AND "poly_position_gap_reservations"."released_cash_guard_atomic" <= "poly_position_gap_reservations"."executor_cash_guard_atomic")
);
--> statement-breakpoint
ALTER TABLE "poly_position_gap_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_position_gap_reservations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "poly_position_gap_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"trigger_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"target_snapshot_id" text,
	"target_snapshot_hash" text,
	"target_snapshot_as_of" timestamp with time zone,
	"target_snapshot_expires_at" timestamp with time zone,
	"target_snapshot" jsonb,
	"planner_version" text,
	"budget_usdc" numeric(20, 8) NOT NULL,
	"eligible_net_nav_usdc" numeric(20, 8),
	"scale" numeric(30, 18),
	"wallet_cash_usdc_at_start" numeric(20, 8) NOT NULL,
	"reserved_budget_usdc_at_start" numeric(20, 8) DEFAULT '0' NOT NULL,
	"reserved_cash_atomic_at_start" numeric(30, 0) DEFAULT '0' NOT NULL,
	"reserved_budget_usdc_at_end" numeric(20, 8),
	"reserved_cash_atomic_at_end" numeric(30, 0),
	"status" text DEFAULT 'running' NOT NULL,
	"plan" jsonb,
	"error_code" text,
	"error_detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poly_position_gap_runs_status_check" CHECK ("poly_position_gap_runs"."status" IN ('running','completed','skipped','halted','failed')),
	CONSTRAINT "poly_position_gap_runs_nonnegative_check" CHECK ("poly_position_gap_runs"."budget_usdc" > 0
        AND "poly_position_gap_runs"."wallet_cash_usdc_at_start" >= 0
        AND "poly_position_gap_runs"."reserved_budget_usdc_at_start" >= 0
        AND "poly_position_gap_runs"."reserved_cash_atomic_at_start" >= 0
        AND ("poly_position_gap_runs"."eligible_net_nav_usdc" IS NULL OR "poly_position_gap_runs"."eligible_net_nav_usdc" >= 0)
        AND ("poly_position_gap_runs"."reserved_budget_usdc_at_end" IS NULL OR "poly_position_gap_runs"."reserved_budget_usdc_at_end" >= 0)
        AND ("poly_position_gap_runs"."reserved_cash_atomic_at_end" IS NULL OR "poly_position_gap_runs"."reserved_cash_atomic_at_end" >= 0))
);
--> statement-breakpoint
ALTER TABLE "poly_position_gap_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "poly_position_gap_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "poly_copy_trade_fills_one_open_per_market";--> statement-breakpoint
ALTER TABLE "poly_position_gap_actions" ADD CONSTRAINT "poly_position_gap_actions_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_actions" ADD CONSTRAINT "poly_position_gap_actions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_actions" ADD CONSTRAINT "poly_position_gap_actions_run_id_poly_position_gap_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."poly_position_gap_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_actions" ADD CONSTRAINT "poly_position_gap_actions_cohort_id_poly_position_gap_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."poly_position_gap_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_cohorts" ADD CONSTRAINT "poly_position_gap_cohorts_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_cohorts" ADD CONSTRAINT "poly_position_gap_cohorts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_cohorts" ADD CONSTRAINT "poly_position_gap_cohorts_created_run_id_poly_position_gap_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."poly_position_gap_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_reservations" ADD CONSTRAINT "poly_position_gap_reservations_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_reservations" ADD CONSTRAINT "poly_position_gap_reservations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_reservations" ADD CONSTRAINT "poly_position_gap_reservations_cohort_id_poly_position_gap_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."poly_position_gap_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_reservations" ADD CONSTRAINT "poly_position_gap_reservations_buy_action_id_poly_position_gap_actions_id_fk" FOREIGN KEY ("buy_action_id") REFERENCES "public"."poly_position_gap_actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_runs" ADD CONSTRAINT "poly_position_gap_runs_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poly_position_gap_runs" ADD CONSTRAINT "poly_position_gap_runs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "poly_position_gap_actions_key_unique" ON "poly_position_gap_actions" USING btree ("billing_account_id","target_id","action_key");--> statement-breakpoint
CREATE UNIQUE INDEX "poly_position_gap_actions_client_order_unique" ON "poly_position_gap_actions" USING btree ("client_order_id") WHERE "poly_position_gap_actions"."client_order_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "poly_position_gap_actions_one_open_buy_per_cohort" ON "poly_position_gap_actions" USING btree ("billing_account_id","target_id","cohort_key") WHERE "poly_position_gap_actions"."kind" = 'buy'
			  AND "poly_position_gap_actions"."status" IN ('reserved','ledgered','submitting','open','partial','cancel_requested','ambiguous');--> statement-breakpoint
CREATE INDEX "poly_position_gap_actions_run_idx" ON "poly_position_gap_actions" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "poly_position_gap_actions_order_idx" ON "poly_position_gap_actions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poly_position_gap_cohorts_key_unique" ON "poly_position_gap_cohorts" USING btree ("billing_account_id","target_id","cohort_key");--> statement-breakpoint
CREATE INDEX "poly_position_gap_cohorts_reduction_idx" ON "poly_position_gap_cohorts" USING btree ("billing_account_id","target_id","benchmark_target_vwap" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "poly_position_gap_reservations_buy_action_unique" ON "poly_position_gap_reservations" USING btree ("buy_action_id");--> statement-breakpoint
CREATE INDEX "poly_position_gap_reservations_active_account_idx" ON "poly_position_gap_reservations" USING btree ("billing_account_id","target_id") WHERE "poly_position_gap_reservations"."state" = 'active';--> statement-breakpoint
CREATE INDEX "poly_position_gap_runs_account_target_started_idx" ON "poly_position_gap_runs" USING btree ("billing_account_id","target_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "poly_position_gap_runs_running_idx" ON "poly_position_gap_runs" USING btree ("billing_account_id","target_id") WHERE "poly_position_gap_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "poly_copy_trade_fills_v3_one_open_per_cohort" ON "poly_copy_trade_fills" USING btree ("billing_account_id","target_id",("attributes"->>'position_gap_cohort_key')) WHERE "poly_copy_trade_fills"."attributes"->>'position_gap_version' = '3'
          AND "poly_copy_trade_fills"."attributes"->>'position_gap_cohort_key' IS NOT NULL
          AND "poly_copy_trade_fills"."status" IN ('pending','open','partial')
          AND ("poly_copy_trade_fills"."position_lifecycle" IS NULL OR "poly_copy_trade_fills"."position_lifecycle" IN ('unresolved','open','closing'))
          AND "poly_copy_trade_fills"."attributes"->>'closed_at' IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "poly_copy_trade_fills_one_open_per_market" ON "poly_copy_trade_fills" USING btree ("billing_account_id","target_id","market_id") WHERE "poly_copy_trade_fills"."status" IN ('pending','open','partial')
          AND ("poly_copy_trade_fills"."position_lifecycle" IS NULL OR "poly_copy_trade_fills"."position_lifecycle" IN ('unresolved','open','closing'))
          AND "poly_copy_trade_fills"."attributes"->>'closed_at' IS NULL
          AND COALESCE("poly_copy_trade_fills"."attributes"->>'position_gap_version', '') <> '3';--> statement-breakpoint
CREATE POLICY "poly_position_gap_actions_select" ON "poly_position_gap_actions" AS PERMISSIVE FOR SELECT TO public USING ("poly_position_gap_actions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR EXISTS (
    SELECT 1 FROM agent_capability_grants grant_row
    WHERE grant_row.billing_account_id = "poly_position_gap_actions"."billing_account_id"
      AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
      AND grant_row.revoked_at IS NULL
      AND grant_row.expires_at > now()
      AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_actions_insert" ON "poly_position_gap_actions" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("poly_position_gap_actions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_actions_update" ON "poly_position_gap_actions" AS PERMISSIVE FOR UPDATE TO public USING ("poly_position_gap_actions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  )) WITH CHECK ("poly_position_gap_actions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_actions_delete" ON "poly_position_gap_actions" AS PERMISSIVE FOR DELETE TO public USING ("poly_position_gap_actions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_cohorts_select" ON "poly_position_gap_cohorts" AS PERMISSIVE FOR SELECT TO public USING ("poly_position_gap_cohorts"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR EXISTS (
    SELECT 1 FROM agent_capability_grants grant_row
    WHERE grant_row.billing_account_id = "poly_position_gap_cohorts"."billing_account_id"
      AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
      AND grant_row.revoked_at IS NULL
      AND grant_row.expires_at > now()
      AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_cohorts_insert" ON "poly_position_gap_cohorts" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("poly_position_gap_cohorts"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_cohorts_update" ON "poly_position_gap_cohorts" AS PERMISSIVE FOR UPDATE TO public USING ("poly_position_gap_cohorts"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  )) WITH CHECK ("poly_position_gap_cohorts"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_cohorts_delete" ON "poly_position_gap_cohorts" AS PERMISSIVE FOR DELETE TO public USING ("poly_position_gap_cohorts"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_reservations_select" ON "poly_position_gap_reservations" AS PERMISSIVE FOR SELECT TO public USING ("poly_position_gap_reservations"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR EXISTS (
    SELECT 1 FROM agent_capability_grants grant_row
    WHERE grant_row.billing_account_id = "poly_position_gap_reservations"."billing_account_id"
      AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
      AND grant_row.revoked_at IS NULL
      AND grant_row.expires_at > now()
      AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_reservations_insert" ON "poly_position_gap_reservations" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("poly_position_gap_reservations"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_reservations_update" ON "poly_position_gap_reservations" AS PERMISSIVE FOR UPDATE TO public USING ("poly_position_gap_reservations"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  )) WITH CHECK ("poly_position_gap_reservations"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_reservations_delete" ON "poly_position_gap_reservations" AS PERMISSIVE FOR DELETE TO public USING ("poly_position_gap_reservations"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_runs_select" ON "poly_position_gap_runs" AS PERMISSIVE FOR SELECT TO public USING ("poly_position_gap_runs"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR EXISTS (
    SELECT 1 FROM agent_capability_grants grant_row
    WHERE grant_row.billing_account_id = "poly_position_gap_runs"."billing_account_id"
      AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
      AND grant_row.revoked_at IS NULL
      AND grant_row.expires_at > now()
      AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_runs_insert" ON "poly_position_gap_runs" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("poly_position_gap_runs"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_runs_update" ON "poly_position_gap_runs" AS PERMISSIVE FOR UPDATE TO public USING ("poly_position_gap_runs"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  )) WITH CHECK ("poly_position_gap_runs"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));--> statement-breakpoint
CREATE POLICY "poly_position_gap_runs_delete" ON "poly_position_gap_runs" AS PERMISSIVE FOR DELETE TO public USING ("poly_position_gap_runs"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ));
