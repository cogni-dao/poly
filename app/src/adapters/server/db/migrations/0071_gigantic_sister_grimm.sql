CREATE TABLE "agent_access_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_principal_id" text NOT NULL,
	"requester_display_name" text NOT NULL,
	"requested_scopes" text[] NOT NULL,
	"grant_expires_at" timestamp with time zone NOT NULL,
	"approval_token_hash" text NOT NULL,
	"approval_token_expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"billing_account_id" text,
	"approved_grant_id" uuid,
	"decision_by_user_id" text,
	"decided_at" timestamp with time zone,
	"token_consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_access_requests_status_canonical" CHECK ("agent_access_requests"."status" IN ('pending','approved','denied','expired','revoked')),
	CONSTRAINT "agent_access_requests_scope_performance_read" CHECK ("agent_access_requests"."requested_scopes" = ARRAY['performance:read']::text[]),
	CONSTRAINT "agent_access_requests_expiry_after_creation" CHECK ("agent_access_requests"."grant_expires_at" > "agent_access_requests"."created_at" AND "agent_access_requests"."approval_token_expires_at" > "agent_access_requests"."created_at"),
	CONSTRAINT "agent_access_requests_lifecycle_consistent" CHECK ((
        "agent_access_requests"."status" IN ('pending','expired')
        AND "agent_access_requests"."billing_account_id" IS NULL
        AND "agent_access_requests"."approved_grant_id" IS NULL
        AND "agent_access_requests"."decision_by_user_id" IS NULL
        AND "agent_access_requests"."decided_at" IS NULL
        AND "agent_access_requests"."token_consumed_at" IS NULL
      ) OR (
        "agent_access_requests"."status" = 'denied'
        AND "agent_access_requests"."billing_account_id" IS NOT NULL
        AND "agent_access_requests"."approved_grant_id" IS NULL
        AND "agent_access_requests"."decision_by_user_id" IS NOT NULL
        AND "agent_access_requests"."decided_at" IS NOT NULL
        AND "agent_access_requests"."token_consumed_at" IS NOT NULL
      ) OR (
        "agent_access_requests"."status" IN ('approved','revoked')
        AND "agent_access_requests"."billing_account_id" IS NOT NULL
        AND "agent_access_requests"."approved_grant_id" IS NOT NULL
        AND "agent_access_requests"."decision_by_user_id" IS NOT NULL
        AND "agent_access_requests"."decided_at" IS NOT NULL
        AND "agent_access_requests"."token_consumed_at" IS NOT NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "agent_access_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_requester_principal_id_users_id_fk" FOREIGN KEY ("requester_principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_approved_grant_id_agent_capability_grants_id_fk" FOREIGN KEY ("approved_grant_id") REFERENCES "public"."agent_capability_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_requests" ADD CONSTRAINT "agent_access_requests_decision_by_user_id_users_id_fk" FOREIGN KEY ("decision_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_access_requests_token_hash_idx" ON "agent_access_requests" USING btree ("approval_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_access_requests_approved_grant_idx" ON "agent_access_requests" USING btree ("approved_grant_id") WHERE "agent_access_requests"."approved_grant_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_access_requests_requester_pending_idx" ON "agent_access_requests" USING btree ("requester_principal_id") WHERE "agent_access_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_access_requests_account_created_idx" ON "agent_access_requests" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE POLICY "agent_access_requests_select" ON "agent_access_requests" AS PERMISSIVE FOR SELECT TO public USING ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        OR "agent_access_requests"."billing_account_id" IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        OR (
          "agent_access_requests"."status" = 'pending'
          AND "agent_access_requests"."approval_token_hash" = current_setting('app.agent_access_request_token_hash', true)
          AND "agent_access_requests"."approval_token_expires_at" > now()
        ));--> statement-breakpoint
CREATE POLICY "agent_access_requests_insert" ON "agent_access_requests" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        AND "agent_access_requests"."status" = 'pending'
        AND "agent_access_requests"."billing_account_id" IS NULL
        AND "agent_access_requests"."approved_grant_id" IS NULL
        AND "agent_access_requests"."decision_by_user_id" IS NULL);--> statement-breakpoint
CREATE POLICY "agent_access_requests_requester_expire" ON "agent_access_requests" AS PERMISSIVE FOR UPDATE TO public USING ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        AND "agent_access_requests"."status" = 'pending'
        AND "agent_access_requests"."approval_token_expires_at" <= now()) WITH CHECK ("agent_access_requests"."requester_principal_id" = current_setting('app.current_user_id', true)
        AND "agent_access_requests"."status" = 'expired'
        AND "agent_access_requests"."billing_account_id" IS NULL
        AND "agent_access_requests"."approved_grant_id" IS NULL
        AND "agent_access_requests"."decision_by_user_id" IS NULL);--> statement-breakpoint
CREATE POLICY "agent_access_requests_owner_update" ON "agent_access_requests" AS PERMISSIVE FOR UPDATE TO public USING ("agent_access_requests"."billing_account_id" IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        ) OR (
          "agent_access_requests"."status" = 'pending'
          AND "agent_access_requests"."approval_token_hash" = current_setting('app.agent_access_request_token_hash', true)
          AND "agent_access_requests"."approval_token_expires_at" > now()
        )) WITH CHECK ("agent_access_requests"."billing_account_id" IN (
          SELECT id FROM billing_accounts
          WHERE owner_user_id = current_setting('app.current_user_id', true)
        )
        AND "agent_access_requests"."decision_by_user_id" = current_setting('app.current_user_id', true));
--> statement-breakpoint
ALTER TABLE "agent_access_requests" FORCE ROW LEVEL SECURITY;
