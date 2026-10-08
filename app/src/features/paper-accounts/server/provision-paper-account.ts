// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/paper-accounts/server/provision-paper-account`
 * Purpose: Create a paper trading account as a first-class tenant — one
 *   `poly_wallet_connections` row with `kind = 'paper'` plus the default
 *   `poly_wallet_grants` row, written atomically. This is the paper analogue of
 *   `PrivyPolyTraderWalletAdapter.provisionWithGrant`.
 * Scope: Domain write only. The caller supplies the transaction-capable db
 *   handle and the already-resolved tenant (features must not reach into
 *   `adapters/server` or `bootstrap`). Does NOT call Privy, does NOT create
 *   key material, does NOT touch the chain, and does NOT read a balance.
 * Invariants:
 *   - GRANT_OR_NOTHING: the connection row and the grant row land in one
 *     transaction. `authorizeIntent` is fail-closed on a missing grant, so a
 *     connection without one is a soft-bricked account. This mirrors the
 *     reason `provisionWithGrant` exists for the live path.
 *   - APPROVALS_PRESTAMPED: `trading_approvals_ready_at` is set at creation.
 *     Paper needs no on-chain approvals, and `authorizeIntent` fail-closes on
 *     NULL, so leaving it null would make the account permanently unable to
 *     place even a simulated order.
 *   - SERIALIZED_PER_TENANT: takes the same `pg_advisory_xact_lock(hashtext(
 *     billing_account_id))` the live provision path takes, so paper creation
 *     and live provisioning cannot interleave for one tenant. The partial
 *     unique index on (billing_account_id, kind) is the DB-level backstop.
 *   - IDEMPOTENT: an existing active paper row is returned as-is with
 *     `created: false`. Re-posting never mints a second account and never
 *     silently re-seeds the balance of an account that may already have traded.
 *   - NO_FABRICATED_VALUES: `seedUsdc` is supplied by the caller and persisted
 *     verbatim as a fixed-point string. Nothing here defaults, rounds toward,
 *     or infers a starting balance.
 * Side-effects: IO (DB writes inside a caller-visible transaction).
 * Links: docs/spec/capability-plane.md, migration 0082
 * @public
 */

import type { Database } from "@cogni/db-client";
import { polyWalletConnections } from "@cogni/db-schema/wallet-connections";
import { polyWalletGrants } from "@cogni/db-schema/wallet-grants";
import { and, eq, isNull, sql } from "drizzle-orm";

import { derivePaperAccountAddress } from "../paper-account-address";

/**
 * A Drizzle transaction handle, derived from the app's concrete `Database` so
 * it is exactly the type `withTenantScope(getAppDb(), ...)` hands its
 * callback. Deriving it from `PostgresJsDatabase<Record<string, unknown>>`
 * instead would NOT match: `Database` carries the full schema as its generic
 * argument, so the two transaction types differ.
 *
 * Taking the transaction rather than the database is deliberate:
 * `withTenantScope` already opens one — that is where
 * `SET LOCAL app.current_user_id` lives, and SET LOCAL is scoped to the
 * transaction — so opening a second one here would nest a pointless savepoint
 * and would let a caller write without ever entering the RLS scope.
 */
export type PaperAccountTx = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** The `kind` discriminator value for paper rows (migration 0082). */
export const PAPER_CONNECTION_KIND = "paper";

/**
 * Scopes auto-issued with a paper account. Identical to the live default so a
 * paper account is cap-for-cap and scope-for-scope comparable to the live one
 * it is twinning; see GRANT_CAPS_MIRROR_LIVE in the contract.
 */
const PAPER_GRANT_SCOPES = ["poly:trade:buy", "poly:trade:sell"] as const;

/**
 * Fills-per-hour ceiling baked into the paper grant. Same value the live
 * default grant uses, for the same twin-comparability reason.
 */
const PAPER_GRANT_HOURLY_FILLS_CAP = 10_000;

/** Decimal places on `poly_wallet_connections.paper_seed_usdc`. */
const PAPER_SEED_SCALE = 8;

export type ProvisionPaperAccountInput = {
  billingAccountId: string;
  createdByUserId: string;
  /** Who accepted the disclosure — constrained to 'user' | 'agent' by CHECK. */
  actorKind: "user" | "agent";
  actorId: string;
  seedUsdc: number;
  defaultGrant: { perOrderUsdcCap: number; dailyUsdcCap: number };
  /** Injected for determinism in tests. */
  now?: Date;
};

export type ProvisionPaperAccountResult = {
  connectionId: string;
  address: `0x${string}`;
  seedUsdc: string;
  created: boolean;
};

/**
 * Create (or idempotently return) the tenant's paper trading account.
 *
 * Must be called inside a transaction — see GRANT_OR_NOTHING.
 *
 * @param tx - An OPEN transaction. Callers get one from `withTenantScope`,
 *   which also sets the RLS actor; writing through the app role means the
 *   `tenant_isolation` WITH CHECK clause is a second, independent guarantee
 *   that this row lands on the caller's own billing account.
 * @public
 */
export async function provisionPaperAccount(
  tx: PaperAccountTx,
  input: ProvisionPaperAccountInput
): Promise<ProvisionPaperAccountResult> {
  const now = input.now ?? new Date();
  const address = derivePaperAccountAddress(input.billingAccountId);
  const seedUsdc = input.seedUsdc.toFixed(PAPER_SEED_SCALE);

  // Same lock key the live provision path uses, so a concurrent /connect and
  // /paper-account for one tenant serialize instead of racing the generation
  // counter or the unique index.
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${input.billingAccountId}))`
  );

  const existing = await tx
    .select({
      id: polyWalletConnections.id,
      address: polyWalletConnections.address,
      paperSeedUsdc: polyWalletConnections.paperSeedUsdc,
    })
    .from(polyWalletConnections)
    .where(
      and(
        eq(polyWalletConnections.billingAccountId, input.billingAccountId),
        eq(polyWalletConnections.kind, PAPER_CONNECTION_KIND),
        isNull(polyWalletConnections.revokedAt)
      )
    )
    .limit(1);

  if (existing[0]) {
    const row = existing[0];
    // IDEMPOTENT: do not re-seed. The account may already have traded, and
    // rewriting its starting balance would silently invalidate every NAV
    // point derived from it.
    return {
      connectionId: row.id,
      address: row.address as `0x${string}`,
      // PAPER_SEED_DECLARED guarantees non-null for a paper row; the `??` is
      // a type narrowing, not a default.
      seedUsdc: row.paperSeedUsdc ?? seedUsdc,
      created: false,
    };
  }

  const [inserted] = await tx
    .insert(polyWalletConnections)
    .values({
      billingAccountId: input.billingAccountId,
      createdByUserId: input.createdByUserId,
      kind: PAPER_CONNECTION_KIND,
      // Privy / AEAD columns stay NULL — a paper account holds no custody.
      // The `live_requires_custody` CHECK permits this only for kind='paper'.
      privyWalletId: null,
      clobApiKeyCiphertext: null,
      encryptionKeyId: null,
      address,
      // Both identity columns are the synthetic address: `funder_address` is
      // what every downstream reader treats as the trading account
      // (readWalletBalanceFact keys off funder_address alone, and a NULL
      // there reads as `no_wallet`).
      funderAddress: address,
      paperSeedUsdc: seedUsdc,
      custodialConsentAcceptedAt: now,
      custodialConsentActorKind: input.actorKind,
      custodialConsentActorId: input.actorId,
      // APPROVALS_PRESTAMPED — see the module invariants.
      tradingApprovalsReadyAt: now,
    })
    .returning({ id: polyWalletConnections.id });

  if (!inserted) {
    throw new Error("paper account insert returned no row");
  }

  // GRANT_OR_NOTHING: same transaction, so a crash cannot leave a paper
  // account that can never authorize an intent.
  await tx.insert(polyWalletGrants).values({
    billingAccountId: input.billingAccountId,
    walletConnectionId: inserted.id,
    createdByUserId: input.createdByUserId,
    scopes: [...PAPER_GRANT_SCOPES],
    perOrderUsdcCap: input.defaultGrant.perOrderUsdcCap.toFixed(2),
    dailyUsdcCap: input.defaultGrant.dailyUsdcCap.toFixed(2),
    hourlyFillsCap: PAPER_GRANT_HOURLY_FILLS_CAP,
    expiresAt: null,
  });

  return {
    connectionId: inserted.id,
    address,
    seedUsdc,
    created: true,
  };
}
