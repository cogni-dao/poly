-- Poly 0094: AGENT_WALLET_IS_NOT_A_PAYEE (story.0090; node-template 0043, the guard half only). The package cannot write this guard, because the payout leaf tables are the node's.
-- Why now: 0093 labels the outside agents of Poly's grant plane with external `agent_principals` rows, the data this guard keys on. A later route that binds a wallet to an agent
--   must find the database already refusing to pay that wallet. #340 promised the guard with the grant-plane PR; `runAgentWalletGuardConformance` runs it in the real-SQL gate.
-- What it does: one trigger function and one BEFORE INSERT trigger on each payout leaf table (`epoch_distribution_leaves`, `distribution_settlement_leaves`). A leaf whose
--   `account_lower` is a wallet bound to, or stored on, a user that has an `agent_principals` row raises check_violation (constraint agent_wallet_is_not_a_payee).
-- Safety on production on its own: it adds objects and changes no row. It reads no row at migration time, so it needs no guard. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on the two leaf tables
--   until the batch commits (it blocks their writes, not their reads; no Poly code writes them today). `SET LOCAL lock_timeout` makes a blocked lock fail the migrate fast.
--   Existing leaves are untouched; only a new insert is checked. The comparison is case-insensitive on both sides, so it does not need node-template 0043's wallet-lowercasing step.
-- The function is NOT security definer: leaf rows are written by the BYPASSRLS service role, so the invoker sees users and user_bindings in full. A definer owned by the
--   RLS-subject migrating role would see zero rows and never fire.
-- Not carried from 0043 (it changes tables this plane does not own): the wallet lowercasing and unique index on user_bindings, and the link_transactions provider check.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_wallet_is_not_a_payee()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_principals ap
    WHERE ap.user_id IN (
      SELECT b.user_id FROM user_bindings b
      WHERE b.provider = 'wallet' AND lower(b.external_id) = lower(NEW.account_lower)
      UNION
      SELECT u.id FROM users u WHERE lower(u.wallet_address) = lower(NEW.account_lower)
    )
  ) THEN
    RAISE EXCEPTION 'wallet % belongs to an agent principal and cannot be a payee', NEW.account_lower
      USING ERRCODE = 'check_violation', CONSTRAINT = 'agent_wallet_is_not_a_payee';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "epoch_distribution_leaves_agent_wallet_is_not_a_payee"
  BEFORE INSERT ON "epoch_distribution_leaves"
  FOR EACH ROW EXECUTE FUNCTION agent_wallet_is_not_a_payee();--> statement-breakpoint
CREATE TRIGGER "distribution_settlement_leaves_agent_wallet_is_not_a_payee"
  BEFORE INSERT ON "distribution_settlement_leaves"
  FOR EACH ROW EXECUTE FUNCTION agent_wallet_is_not_a_payee();
