CREATE INDEX "poly_copy_trade_decisions_investigation_idx" ON "poly_copy_trade_decisions" USING btree ("billing_account_id",("intent"->>'market_id'),"mode","decided_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "poly_copy_trade_fills_investigation_idx" ON "poly_copy_trade_fills" USING btree ("billing_account_id","market_id","mode","observed_at" DESC NULLS LAST,"target_id" DESC NULLS LAST,"fill_id" DESC NULLS LAST);--> statement-breakpoint

-- story.5003: delegates need target policy/config to interpret account-scoped
-- performance. The table has no signing material; writes stay owner-only.
DROP POLICY IF EXISTS "tenant_isolation" ON "poly_copy_trade_targets";--> statement-breakpoint
CREATE POLICY "poly_copy_trade_targets_select" ON "poly_copy_trade_targets"
  AS PERMISSIVE FOR SELECT TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    OR EXISTS (
      SELECT 1 FROM agent_capability_grants grant_row
      WHERE grant_row.billing_account_id = "poly_copy_trade_targets"."billing_account_id"
        AND grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
        AND grant_row.revoked_at IS NULL
        AND grant_row.expires_at > now()
        AND grant_row.scopes @> ARRAY['performance:read']::text[]
    )
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_targets_insert" ON "poly_copy_trade_targets"
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
    AND "created_by_user_id" = current_setting('app.current_user_id', true)
  );--> statement-breakpoint
CREATE POLICY "poly_copy_trade_targets_update" ON "poly_copy_trade_targets"
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
CREATE POLICY "poly_copy_trade_targets_delete" ON "poly_copy_trade_targets"
  AS PERMISSIVE FOR DELETE TO public
  USING (
    "billing_account_id" IN (
      SELECT id FROM billing_accounts
      WHERE owner_user_id = current_setting('app.current_user_id', true)
    )
  );
