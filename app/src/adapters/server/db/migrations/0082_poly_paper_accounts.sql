-- ============================================================================
-- Paper accounts as a first-class tenant kind.
--
-- WHY THIS EXISTS
-- Paper trading was selected by a process-wide env var (PAPER_ENFORCE_MODE)
-- and owned NO account row. Measured on candidate-a 2026-10-07: the mirror ran
-- 100 decisions in 9 minutes while the dashboard rendered "No trading wallet
-- connected yet", because readWalletBalanceFact drives FROM
-- poly_wallet_connections and a paper tenant had no row to drive from. Paper
-- traded with no account, so nothing downstream could see it.
--
-- Rather than teach each reader a second code path, this migration
-- discriminates the EXISTING tenant table by `kind`. getAddress,
-- listActiveTradingAddresses, getConnectionSummary, readWalletBalanceFact, the
-- dashboard and the capability plane all key off one row per tenant, so paper
-- parity becomes structural instead of re-implemented per reader.
--
-- WHY THE THREE NOT NULLs COME OFF
-- privy_wallet_id / clob_api_key_ciphertext / encryption_key_id describe Privy
-- custody and AEAD CLOB credentials. A paper account has none of those by
-- definition. They are relaxed at the column level and immediately re-imposed
-- for live rows by `poly_wallet_connections_live_requires_custody`, so a live
-- row with incomplete custody remains impossible — 0082 widens the table
-- without weakening a single pre-0082 live-row guarantee. `address` stays NOT
-- NULL: a paper row supplies a synthetic deterministic address so the existing
-- address-shape CHECK and the (chain_id, address) unique index still hold.
--
-- WHERE THE SEED BALANCE LIVES, AND WHY NOT A SIDE TABLE
-- `paper_seed_usdc` is a column on the connection row, not a separate
-- poly_paper_accounts table. A side table would need its own RLS policy, its
-- own delegated-SELECT policy to stay readable through the capability plane
-- (migration 0075), and a new join in every NAV reader — re-introducing
-- exactly the drive-from-connections-and-join shape that made the dashboard
-- read empty in the first place. As a column it inherits 0030's tenant
-- isolation and 0075's delegated SELECT for free. The CHECK makes it NOT NULL
-- and > 0 iff kind = 'paper' and NULL otherwise, so a paper account cannot
-- exist without a declared starting balance (NO_FABRICATED_VALUES) and a live
-- account can never carry a simulated one.
--
-- POPULATED-TABLE SAFETY
-- ADD COLUMN ... DEFAULT ... NOT NULL is the PG11+ non-rewriting fast path and
-- backfills every existing row to 'privy_live'. All three new CHECKs validate
-- true for those backfilled rows. The replacement unique index widens
-- (billing_account_id) to (billing_account_id, kind), which is strictly weaker
-- on data that already held at most one active row per account, so it cannot
-- fail to build. Every statement runs in drizzle's single migration
-- transaction.
--
-- PINNED INVARIANTS
--   KIND_IS_THE_DISCRIMINATOR
--     Branch on `kind`, never on which nullable column happens to be set.
--     Every custody path (Privy signing, AEAD decrypt, CLOB cred rotation,
--     on-chain approvals) is privy_live-only and MUST filter on it.
--   LIVE_ROW_CUSTODY_COMPLETE
--     kind = 'privy_live' implies all three custody columns are NOT NULL.
--   PAPER_SEED_DECLARED
--     paper_seed_usdc NOT NULL and > 0 iff kind = 'paper', NULL otherwise.
--   RLS_IS_KIND_AGNOSTIC
--     0030's tenant_isolation and 0075's delegated SELECT key on
--     billing_account_id only. A paper row is exactly as tenant-isolated as a
--     live one; no new policy is needed and none is added here.
--
-- Links: docs/spec/capability-plane.md, docs/spec/poly-tenant-and-collateral.md
-- ============================================================================

ALTER TABLE "poly_wallet_connections" DROP CONSTRAINT "poly_wallet_connections_privy_wallet_id_nonempty";--> statement-breakpoint
DROP INDEX "poly_wallet_connections_tenant_active_idx";--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ALTER COLUMN "privy_wallet_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ALTER COLUMN "clob_api_key_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ALTER COLUMN "encryption_key_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD COLUMN "kind" text DEFAULT 'privy_live' NOT NULL;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD COLUMN "paper_seed_usdc" numeric(20, 8);--> statement-breakpoint
CREATE UNIQUE INDEX "poly_wallet_connections_tenant_active_idx" ON "poly_wallet_connections" USING btree ("billing_account_id","kind") WHERE "poly_wallet_connections"."revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD CONSTRAINT "poly_wallet_connections_kind_check" CHECK ("poly_wallet_connections"."kind" IN ('privy_live', 'paper'));--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD CONSTRAINT "poly_wallet_connections_live_requires_custody" CHECK ("poly_wallet_connections"."kind" = 'paper' OR ("poly_wallet_connections"."privy_wallet_id" IS NOT NULL AND "poly_wallet_connections"."clob_api_key_ciphertext" IS NOT NULL AND "poly_wallet_connections"."encryption_key_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD CONSTRAINT "poly_wallet_connections_paper_seed_usdc" CHECK (("poly_wallet_connections"."kind" = 'paper' AND "poly_wallet_connections"."paper_seed_usdc" IS NOT NULL AND "poly_wallet_connections"."paper_seed_usdc" > 0) OR ("poly_wallet_connections"."kind" <> 'paper' AND "poly_wallet_connections"."paper_seed_usdc" IS NULL));--> statement-breakpoint
ALTER TABLE "poly_wallet_connections" ADD CONSTRAINT "poly_wallet_connections_privy_wallet_id_nonempty" CHECK ("poly_wallet_connections"."privy_wallet_id" IS NULL OR char_length("poly_wallet_connections"."privy_wallet_id") > 0);