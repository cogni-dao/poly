ALTER POLICY "poly_position_gap_actions_select" ON "poly_position_gap_actions" TO public USING ("poly_position_gap_actions"."billing_account_id" IN (
    SELECT id FROM billing_accounts
    WHERE owner_user_id = current_setting('app.current_user_id', true)
  ) OR "poly_position_gap_actions"."billing_account_id" IN (
        SELECT grant_row.billing_account_id FROM agent_capability_grants grant_row
        WHERE grant_row.grantee_principal_id = current_setting('app.current_user_id', true)
          AND grant_row.revoked_at IS NULL
          AND grant_row.expires_at > now()
          AND grant_row.scopes && ARRAY['account:read','performance:read']::text[]
      ));