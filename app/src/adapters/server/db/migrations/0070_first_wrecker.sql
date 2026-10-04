CREATE TABLE "agent_capability_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" text NOT NULL,
	"grantee_principal_id" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_capability_grants_scopes_nonempty" CHECK (cardinality("agent_capability_grants"."scopes") > 0),
	CONSTRAINT "agent_capability_grants_scopes_canonical" CHECK ("agent_capability_grants"."scopes" <@ ARRAY['performance:read','research:run','policy:propose','paper:assign','live:approve','live:assign']::text[]),
	CONSTRAINT "agent_capability_grants_expiry_after_creation" CHECK ("agent_capability_grants"."expires_at" > "agent_capability_grants"."created_at"),
	CONSTRAINT "agent_capability_grants_revocation_audit" CHECK (("agent_capability_grants"."revoked_at" IS NULL AND "agent_capability_grants"."revoked_by_user_id" IS NULL) OR ("agent_capability_grants"."revoked_at" IS NOT NULL AND "agent_capability_grants"."revoked_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_billing_account_id_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "public"."billing_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_grantee_principal_id_users_id_fk" FOREIGN KEY ("grantee_principal_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grants" ADD CONSTRAINT "agent_capability_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_capability_grants_current_idx" ON "agent_capability_grants" USING btree ("billing_account_id","grantee_principal_id") WHERE "agent_capability_grants"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agent_capability_grants_grantee_active_idx" ON "agent_capability_grants" USING btree ("grantee_principal_id","expires_at");--> statement-breakpoint
CREATE INDEX "agent_capability_grants_account_created_idx" ON "agent_capability_grants" USING btree ("billing_account_id","created_at");--> statement-breakpoint
CREATE POLICY "agent_capability_grants_select" ON "agent_capability_grants" AS PERMISSIVE FOR SELECT TO public USING ("agent_capability_grants"."billing_account_id" IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ) OR "agent_capability_grants"."grantee_principal_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "agent_capability_grants_insert" ON "agent_capability_grants" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("agent_capability_grants"."billing_account_id" IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ) AND "agent_capability_grants"."created_by_user_id" = current_setting('app.current_user_id', true));--> statement-breakpoint
CREATE POLICY "agent_capability_grants_update" ON "agent_capability_grants" AS PERMISSIVE FOR UPDATE TO public USING ("agent_capability_grants"."billing_account_id" IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      )) WITH CHECK ("agent_capability_grants"."billing_account_id" IN (
        SELECT id FROM billing_accounts
        WHERE owner_user_id = current_setting('app.current_user_id', true)
      ));--> statement-breakpoint
ALTER TABLE "agent_capability_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Story 1: delegates may read saved performance rows only while an active
-- `performance:read` grant exists. Every write policy remains owner-only.
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_copy_trade_fills";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_fills_select" ON "poly_copy_trade_fills"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_copy_trade_fills"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes @> ARRAY['performance:read']::text[]
    )
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_fills_insert" ON "poly_copy_trade_fills"
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    AND "created_by_user_id" = current_setting('app.current_user_id', true)
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_fills_update" ON "poly_copy_trade_fills"
  AS PERMISSIVE FOR UPDATE TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    AND "created_by_user_id" = current_setting('app.current_user_id', true)
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_fills_delete" ON "poly_copy_trade_fills"
  AS PERMISSIVE FOR DELETE TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  );--> statement-breakpoint

DROP POLICY IF EXISTS "tenant_isolation" ON "poly_copy_trade_decisions";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_decisions_select" ON "poly_copy_trade_decisions"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_copy_trade_decisions"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes @> ARRAY['performance:read']::text[]
    )
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_decisions_insert" ON "poly_copy_trade_decisions"
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    AND "created_by_user_id" = current_setting('app.current_user_id', true)
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_decisions_update" ON "poly_copy_trade_decisions"
  AS PERMISSIVE FOR UPDATE TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  )
  WITH CHECK (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    AND "created_by_user_id" = current_setting('app.current_user_id', true)
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_decisions_delete" ON "poly_copy_trade_decisions"
  AS PERMISSIVE FOR DELETE TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  );
