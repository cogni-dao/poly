// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/wallet-connections`
 * Purpose: Schema for per-tenant Polymarket trading accounts (task.0318 Phase B;
 *   `kind` discriminator added by migration 0082). One active
 *   `poly_wallet_connections` row per (billing account, kind). A `privy_live`
 *   row binds to a Privy server-wallet id in the DEDICATED user-wallets Privy
 *   app (not the operator-wallet system app) plus AEAD-encrypted Polymarket
 *   CLOB L2 creds. A `paper` row is a simulated account: no Privy wallet, no
 *   creds, a synthetic deterministic address, and a declared seed balance.
 *   Discriminating here rather than in a side table is what makes paper a
 *   first-class tenant — `getAddress`, `listActiveTradingAddresses`,
 *   `getConnectionSummary` and `readWalletBalanceFact` all key off this one
 *   row, so parity is structural instead of re-implemented per reader.
 * Scope: Drizzle table definition only. No queries, no RLS policy (lives in
 *   migrations `0030_poly_wallet_connections.sql` + `0075`), no runtime logic.
 *   The RLS policies key on billing_account_id and are deliberately
 *   kind-agnostic: a paper row is as tenant-isolated as a live one.
 * Invariants:
 *   - TENANT_SCOPED: (billing_account_id, created_by_user_id) NOT NULL.
 *   - CREDS_ENCRYPTED_AT_REST: clob_api_key_ciphertext is bytea from the
 *     aeadEncrypt helper in `@cogni/node-shared/crypto/aead`.
 *   - CUSTODIAL_CONSENT: custodial_consent_accepted_at NOT NULL (app enforces
 *     before insert; DB carries NOT NULL as backstop).
 *   - KIND_IS_THE_DISCRIMINATOR: `kind IN ('privy_live','paper')`. Never infer
 *     a row's nature from which nullable columns happen to be set; branch on
 *     `kind`. Every custody path (Privy signing, AEAD decrypt, CLOB cred
 *     rotation, on-chain approvals) is `privy_live`-only and MUST filter on it.
 *   - LIVE_ROW_CUSTODY_COMPLETE: privy_wallet_id / clob_api_key_ciphertext /
 *     encryption_key_id are nullable for paper but a CHECK re-imposes all three
 *     as NOT NULL whenever `kind = 'privy_live'`, so 0082 widened the table
 *     without weakening a single live-row guarantee.
 *   - PAPER_SEED_DECLARED: paper_seed_usdc is NOT NULL and > 0 iff
 *     `kind = 'paper'`, and NULL otherwise. A paper account cannot exist
 *     without a declared starting balance (NO_FABRICATED_VALUES) and a live
 *     account can never carry a simulated one.
 *   - REVOKE_IS_DURABLE: revoked_at is the soft-delete kill-switch. Partial
 *     unique index on (billing_account_id, kind) WHERE revoked_at IS NULL
 *     allows re-provisioning after revoke, and lets one tenant hold a live
 *     wallet and a paper account at the same time.
 *   - SEPARATE_PRIVY_APP: privy_wallet_id references the USER-WALLETS Privy
 *     app only. The app-layer adapter enforces this; the DB cannot.
 *   - APPROVALS_BEFORE_PLACE: trading_approvals_ready_at is the on-chain
 *     readiness stamp for the official V2 Deposit Wallet approval workflow.
 *     authorizeIntent fails-closed when NULL.
 *     Cleared app-side alongside revoked_at so a fresh post-revoke row
 *     re-runs the approvals flow.
 * Side-effects: none (schema only)
 * Links: docs/spec/poly-tenant-and-collateral.md,
 *        docs/spec/poly-tenant-and-collateral.md,
 *        work/items/task.0318.poly-wallet-multi-tenant-auth.md
 * @public
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgPolicy,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  customType,
} from "drizzle-orm/pg-core";
import { billingAccounts } from "./refs";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Per-tenant Polymarket trading wallet binding.
 *
 * One active row per `billing_account_id` (partial unique index). Stores the
 * Privy server-wallet id (in the USER-WALLETS Privy app) + encrypted L2 CLOB
 * creds + allowance snapshot + custodial-consent trail.
 *
 * @public
 */
export const polyWalletConnections = pgTable(
  "poly_wallet_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Tenant data column. FK → billing_accounts.id (enforced in migration). */
    billingAccountId: text("billing_account_id").notNull(),
    /** RLS key column. FK → users.id. */
    createdByUserId: text("created_by_user_id").notNull(),
    /**
     * Tenant discriminator (migration 0082). `privy_live` = a real Privy
     * server-wallet with AEAD CLOB creds and on-chain custody. `paper` = a
     * simulated account: no Privy wallet, no creds, a synthetic address, and a
     * declared `paperSeedUsdc`. KIND_IS_THE_DISCRIMINATOR — never infer a row's
     * nature from which columns happen to be null.
     */
    kind: text("kind").notNull().default("privy_live"),
    /**
     * Privy server-wallet id in the USER-WALLETS Privy app. NULL iff
     * `kind = 'paper'` (CHECK `..._live_requires_custody`).
     */
    privyWalletId: text("privy_wallet_id"),
    /** Checksummed Privy signer EOA address. */
    address: text("address").notNull(),
    /**
     * Active Polymarket account/funder. New V2 wallets use the deterministic
     * Deposit Wallet; null marks a legacy EOA row that must be migrated by the
     * explicit enable-trading flow before new orders are authorized.
     */
    funderAddress: text("funder_address"),
    /** 137 = Polygon mainnet today. */
    chainId: integer("chain_id").notNull().default(137),
    /**
     * AEAD ciphertext of the JSON-serialized ApiKeyCreds. NULL iff
     * `kind = 'paper'` — a paper account never holds CLOB credentials.
     */
    clobApiKeyCiphertext: bytea("clob_api_key_ciphertext"),
    /**
     * Key-ring id used to encrypt `clobApiKeyCiphertext`. Enables rotation.
     * NULL iff `kind = 'paper'`.
     */
    encryptionKeyId: text("encryption_key_id"),
    /**
     * Starting simulated collateral, in USDC. NOT NULL iff `kind = 'paper'`
     * and NULL iff `kind = 'privy_live'` (CHECK `..._paper_seed_usdc`) — a
     * paper account cannot exist without a declared starting balance, and a
     * live account can never carry a fabricated one (NO_FABRICATED_VALUES).
     * Precision matches `poly_wallet_balance_snapshots.usdc_e` so the NAV
     * projection that reads this is type-consistent with the live cash fact.
     */
    paperSeedUsdc: numeric("paper_seed_usdc", { precision: 20, scale: 8 }),
    /** Last observed on-chain allowance snapshot (Exchange + NegRisk + CTF). */
    allowanceState: jsonb("allowance_state"),
    /** When the tenant accepted the custodial disclosure. */
    custodialConsentAcceptedAt: timestamp("custodial_consent_accepted_at", {
      withTimezone: true,
    }).notNull(),
    /** 'user' or 'agent' — who accepted the disclosure. */
    custodialConsentActorKind: text("custodial_consent_actor_kind").notNull(),
    /** Principal id of the actor that accepted. */
    custodialConsentActorId: text("custodial_consent_actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /**
     * Stamped by `PrivyPolyTraderWalletAdapter.ensureTradingApprovals` once the
     * official V2 Deposit Wallet setup and approvals complete. `null`
     * means the wallet is provisioned but cannot yet trade — the
     * `APPROVALS_BEFORE_PLACE` invariant on `authorizeIntent` fail-closes.
     */
    tradingApprovalsReadyAt: timestamp("trading_approvals_ready_at", {
      withTimezone: true,
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: text("revoked_by_user_id"),
    /**
     * Stamped when the tenant grants consent to the auto-wrap loop (task.0429).
     * `null` = no consent, the auto-wrap job MUST skip this row. Independent of
     * `custodialConsentAcceptedAt` (which gates wallet provisioning) and of
     * `tradingApprovalsReadyAt` (which gates order placement).
     */
    autoWrapConsentAt: timestamp("auto_wrap_consent_at", {
      withTimezone: true,
    }),
    /** 'user' or 'agent' — set IFF `autoWrapConsentAt` is non-null. */
    autoWrapConsentActorKind: text("auto_wrap_consent_actor_kind"),
    /** Principal id of the actor that consented. */
    autoWrapConsentActorId: text("auto_wrap_consent_actor_id"),
    /**
     * Minimum USDC.e balance (6-dp base units) the job will wrap. DUST_GUARD
     * (task.0429): below floor → skip, prevents gas-on-dust drain. Default
     * 1_000_000 = 1.00 USDC.e.
     */
    autoWrapFloorUsdceE6dp: bigint("auto_wrap_floor_usdce_6dp", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`1000000`),
    /**
     * Revoke marker independent of `revokedAt`. Lets a tenant turn auto-wrap
     * off without killing the connection. CONSENT_REVOCABLE (task.0429): the
     * job tick re-derives consent each scan; revoke is honored on the next
     * tick.
     */
    autoWrapRevokedAt: timestamp("auto_wrap_revoked_at", {
      withTimezone: true,
    }),
  },
  (table) => ({
    addressShape: check(
      "poly_wallet_connections_address_shape",
      sql`${table.address} ~ '^0x[a-fA-F0-9]{40}$'`,
    ),
    funderAddressShape: check(
      "poly_wallet_connections_funder_address_shape",
      sql`${table.funderAddress} IS NULL OR ${table.funderAddress} ~ '^0x[a-fA-F0-9]{40}$'`,
    ),
    kindCheck: check(
      "poly_wallet_connections_kind_check",
      sql`${table.kind} IN ('privy_live', 'paper')`,
    ),
    /**
     * Preserves every pre-0082 guarantee for live rows. Dropping the three
     * NOT NULLs widened the table for paper; this narrows it straight back for
     * `privy_live`, so a live row with missing custody is still impossible.
     */
    liveRequiresCustody: check(
      "poly_wallet_connections_live_requires_custody",
      sql`${table.kind} = 'paper' OR (${table.privyWalletId} IS NOT NULL AND ${table.clobApiKeyCiphertext} IS NOT NULL AND ${table.encryptionKeyId} IS NOT NULL)`,
    ),
    paperSeedUsdcCheck: check(
      "poly_wallet_connections_paper_seed_usdc",
      sql`(${table.kind} = 'paper' AND ${table.paperSeedUsdc} IS NOT NULL AND ${table.paperSeedUsdc} > 0) OR (${table.kind} <> 'paper' AND ${table.paperSeedUsdc} IS NULL)`,
    ),
    privyWalletIdNonempty: check(
      "poly_wallet_connections_privy_wallet_id_nonempty",
      sql`${table.privyWalletId} IS NULL OR char_length(${table.privyWalletId}) > 0`,
    ),
    consentActorKind: check(
      "poly_wallet_connections_consent_actor_kind",
      sql`${table.custodialConsentActorKind} IN ('user', 'agent')`,
    ),
    /**
     * One active row per (tenant, kind) — a tenant may hold one live wallet
     * AND one paper account simultaneously. Revoked rows do not block
     * re-provisioning (REVOKE_IS_DURABLE).
     */
    tenantActive: uniqueIndex("poly_wallet_connections_tenant_active_idx")
      .on(table.billingAccountId, table.kind)
      .where(sql`${table.revokedAt} IS NULL`),
    addressChainActive: uniqueIndex(
      "poly_wallet_connections_address_chain_active_idx",
    )
      .on(table.chainId, table.address)
      .where(sql`${table.revokedAt} IS NULL`),
    byUser: index("poly_wallet_connections_created_by_user_idx").on(
      table.createdByUserId,
    ),
    /** Matches migration `0032_poly_wallet_trading_approvals.sql`. */
    tradingReadyIdx: index("poly_wallet_connections_trading_ready_idx")
      .on(table.billingAccountId)
      .where(
        sql`${table.revokedAt} IS NULL AND ${table.tradingApprovalsReadyAt} IS NOT NULL`,
      ),
    autoWrapConsentActorKindCheck: check(
      "poly_wallet_connections_auto_wrap_consent_actor_kind",
      sql`${table.autoWrapConsentActorKind} IS NULL OR ${table.autoWrapConsentActorKind} IN ('user', 'agent')`,
    ),
    autoWrapConsentTrioCheck: check(
      "poly_wallet_connections_auto_wrap_consent_trio",
      sql`(${table.autoWrapConsentAt} IS NULL AND ${table.autoWrapConsentActorKind} IS NULL AND ${table.autoWrapConsentActorId} IS NULL) OR (${table.autoWrapConsentAt} IS NOT NULL AND ${table.autoWrapConsentActorKind} IS NOT NULL AND ${table.autoWrapConsentActorId} IS NOT NULL)`,
    ),
    autoWrapFloorPositiveCheck: check(
      "poly_wallet_connections_auto_wrap_floor_positive",
      sql`${table.autoWrapFloorUsdceE6dp} > 0`,
    ),
    /** Hot path for the auto-wrap job scan (task.0429). */
    autoWrapEligibleIdx: index(
      "poly_wallet_connections_auto_wrap_eligible_idx",
    )
      .on(table.billingAccountId)
      .where(
        sql`${table.revokedAt} IS NULL AND ${table.autoWrapConsentAt} IS NOT NULL AND ${table.autoWrapRevokedAt} IS NULL`,
      ),
  }),
);

/** Latest off-render Polygon balance observation for one tenant wallet. */
export const polyWalletBalanceSnapshots = pgTable(
  "poly_wallet_balance_snapshots",
  {
    billingAccountId: text("billing_account_id")
      .primaryKey()
      .references(() => billingAccounts.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    usdcE: numeric("usdc_e", { precision: 20, scale: 8 }),
    pusd: numeric("pusd", { precision: 20, scale: 8 }),
    pol: numeric("pol", { precision: 30, scale: 18 }),
    status: text("status").notNull(),
    errors: jsonb("errors").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "poly_wallet_balance_snapshots_address_shape",
      sql`${table.address} ~ '^0x[a-fA-F0-9]{40}$'`
    ),
    check(
      "poly_wallet_balance_snapshots_status_check",
      sql`${table.status} IN ('ok','partial','error')`
    ),
    check(
      "poly_wallet_balance_snapshots_nonnegative",
      sql`(${table.usdcE} IS NULL OR ${table.usdcE} >= 0) AND (${table.pusd} IS NULL OR ${table.pusd} >= 0) AND (${table.pol} IS NULL OR ${table.pol} >= 0)`
    ),
    check(
      "poly_wallet_balance_snapshots_status_values",
      sql`(${table.status} = 'ok' AND num_nonnulls(${table.usdcE}, ${table.pusd}, ${table.pol}) = 3) OR (${table.status} = 'partial' AND num_nonnulls(${table.usdcE}, ${table.pusd}, ${table.pol}) BETWEEN 1 AND 2) OR (${table.status} = 'error' AND num_nonnulls(${table.usdcE}, ${table.pusd}, ${table.pol}) = 0)`
    ),
    pgPolicy("tenant_isolation", {
      for: "all",
      using: sql`${table.billingAccountId} IN (SELECT id FROM billing_accounts WHERE owner_user_id = current_setting('app.current_user_id', true))`,
      withCheck: sql`${table.billingAccountId} IN (SELECT id FROM billing_accounts WHERE owner_user_id = current_setting('app.current_user_id', true))`,
    }),
  ]
).enableRLS();

export type PolyWalletConnectionRow = typeof polyWalletConnections.$inferSelect;
export type PolyWalletConnectionInsert =
  typeof polyWalletConnections.$inferInsert;
