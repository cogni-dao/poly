// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/paper-accounts/server/paper-venue`
 * Purpose: The authorization + identity surface of a paper trading account.
 *   Paper placements used to skip `authorizeIntent` entirely and log
 *   `authorize_bypassed: true`; since 0082 a paper account owns a real
 *   connection row AND a real `poly_wallet_grants` row, so there is nothing
 *   left to bypass. This module runs the same decision sequence the live
 *   adapter runs, against the paper account's own rows.
 * Scope: Reads `poly_wallet_connections` (kind='paper'), `poly_wallet_grants`,
 *   and the `poly_copy_trade_fills` cap windows. No writes. No Privy, no
 *   chain, no signing — a paper account has no key material, so this produces
 *   a decision, never an `AuthorizedSigningContext`.
 * Invariants:
 *   - PAPER_ROWS_ONLY: every query filters `kind = 'paper'`. The mirror of
 *     `LIVE_ROWS_ONLY` in `privy-poly-trader-wallet.adapter.ts` — a tenant may
 *     hold one active row of each kind, and authorizing a paper intent off the
 *     live row (or vice versa) would charge one account's caps to the other.
 *   - SAME_DECISION_SEQUENCE: approvals stamp → grant presence → expiry →
 *     scope → per-order cap → daily cap → hourly fills cap, in that order,
 *     matching `PrivyPolyTraderWalletAdapter.authorizeIntent`. Reordering would
 *     make a paper account's denial reason incomparable to its live twin's,
 *     which is the entire point of running paper.
 *   - CAP_WINDOWS_ARE_MODE_SCOPED: the 24h spend and 1h fill-count windows
 *     filter `poly_copy_trade_fills.mode = 'paper'`, so a paper account's caps
 *     count paper activity only. Without this a tenant running both kinds
 *     would see its simulated orders consume its live daily cap.
 *   - FAIL_CLOSED: a missing paper connection, a missing grant, or an
 *     unreachable DB denies. Nothing here can return `ok: true` by default.
 *   - NO_FABRICATED_VALUES: `resolveAccount` returns the address and seed
 *     stored on the row. It does not derive the address (that is
 *     `derivePaperAccountAddress`, used only at provision time) and does not
 *     invent a seed for a row that somehow lacks one.
 * Side-effects: IO (SELECTs).
 * Links: docs/spec/capability-plane.md, migration 0082,
 *   app/src/adapters/server/wallet/privy-poly-trader-wallet.adapter.ts
 *   (the live counterpart of the decision sequence)
 * @public
 */

import {
  polyCopyTradeFills,
  polyWalletConnections,
  polyWalletGrants,
} from "@cogni/poly-db-schema";
import type { AuthorizationFailure, OrderIntentSummary } from "@cogni/poly-wallet";
import { and, count, desc, eq, gte, inArray, isNull, sql, sum } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { PAPER_CONNECTION_KIND } from "./provision-paper-account";

/**
 * Fill statuses that have USDC attached, live or simulated. Same list the live
 * adapter uses (`IN_FLIGHT_FILL_STATUSES`): counting only `filled` lets two
 * concurrent pending orders race past a cap.
 */
const IN_FLIGHT_FILL_STATUSES = [
  "pending",
  "open",
  "filled",
  "partial",
] as const;

/** `poly_copy_trade_{fills,decisions}.mode` value for simulated execution. */
const PAPER_LEDGER_MODE = "paper";

/** Identity of one tenant's paper account, read off its connection row. */
export interface PaperAccountIdentity {
  readonly connectionId: string;
  /**
   * The synthetic address the account trades under. Address-shaped so every
   * existing `lower(address)` join keeps working; NOT a keypair — nothing may
   * sign for, fund, or observe it on chain.
   */
  readonly funderAddress: `0x${string}`;
  /** Fixed-point USDC the account started with. */
  readonly seedUsdc: string;
}

/** Decision for one paper intent. No signing context exists to return. */
export type PaperAuthorizeResult =
  | { readonly ok: true; readonly grantId: string }
  | { readonly ok: false; readonly reason: AuthorizationFailure };

/**
 * Thrown by `resolveAccount` when the tenant has no usable paper account.
 * Separate from a denial: a denial is a decision about an intent, this is the
 * absence of the account the decision would be about.
 */
export class PaperAccountUnavailableError extends Error {
  constructor(
    public readonly billingAccountId: string,
    public readonly reason: "no_connection" | "backend_unreachable",
    cause?: unknown
  ) {
    super(
      `poly paper account unavailable for billingAccountId=${billingAccountId} (${reason})`
    );
    this.name = "PaperAccountUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

/** The paper venue's authorization + identity surface. */
export interface PaperVenuePort {
  /** @throws {PaperAccountUnavailableError} when no active paper row exists. */
  resolveAccount(billingAccountId: string): Promise<PaperAccountIdentity>;
  /** Real grant decision for a paper intent. Never throws on a denial. */
  authorizeIntent(
    billingAccountId: string,
    intent: OrderIntentSummary
  ): Promise<PaperAuthorizeResult>;
}

/** The subset of a grant row the decision depends on. */
export interface PaperGrantFacts {
  readonly id: string;
  readonly scopes: readonly string[];
  readonly perOrderUsdcCap: number;
  readonly dailyUsdcCap: number;
  readonly hourlyFillsCap: number;
  readonly expiresAt: Date | null;
}

/**
 * Everything decidable WITHOUT the cap-window counters: approvals stamp, grant
 * presence, expiry, scope, per-order cap. Pure, so the sequence is unit-
 * testable and the DB wrapper can skip the two counter queries whenever one of
 * these already denies.
 *
 * @public
 */
export function evaluatePaperGrantPreconditions(input: {
  intent: OrderIntentSummary;
  tradingApprovalsReadyAt: Date | null;
  grant: PaperGrantFacts | null;
  now: Date;
}): PaperAuthorizeResult {
  // APPROVALS_BEFORE_PLACE — paper needs no on-chain approvals and has the
  // stamp written at provision time, so a NULL here means the row was not
  // created by `provisionPaperAccount`. Deny rather than assume.
  if (!input.tradingApprovalsReadyAt) {
    return { ok: false, reason: "trading_not_ready" };
  }
  const grant = input.grant;
  if (!grant) return { ok: false, reason: "no_active_grant" };
  if (grant.expiresAt && grant.expiresAt.getTime() <= input.now.getTime()) {
    return { ok: false, reason: "grant_expired" };
  }
  const requiredScope =
    input.intent.side === "BUY" ? "poly:trade:buy" : "poly:trade:sell";
  if (!grant.scopes.includes(requiredScope)) {
    return { ok: false, reason: "scope_missing" };
  }
  if (input.intent.usdcAmount > grant.perOrderUsdcCap) {
    return { ok: false, reason: "cap_exceeded_per_order" };
  }
  return { ok: true, grantId: grant.id };
}

/**
 * The two window caps, given the counters. Pure.
 *
 * @public
 */
export function evaluatePaperCapWindows(input: {
  intent: OrderIntentSummary;
  grant: PaperGrantFacts;
  spent24hUsdc: number;
  fillsLastHour: number;
}): PaperAuthorizeResult {
  if (input.spent24hUsdc + input.intent.usdcAmount > input.grant.dailyUsdcCap) {
    return { ok: false, reason: "cap_exceeded_daily" };
  }
  if (input.fillsLastHour >= input.grant.hourlyFillsCap) {
    return { ok: false, reason: "cap_exceeded_hourly_fills" };
  }
  return { ok: true, grantId: input.grant.id };
}

/**
 * Build the paper venue over a Drizzle handle.
 *
 * @param deps.db - Drizzle client. The hot path is cross-tenant (the mirror
 *   loop), so bootstrap passes the service client; every query below is
 *   tenant-keyed and kind-keyed in its predicate.
 * @param deps.now - Injected clock for tests.
 * @public
 */
export function createPaperVenue(deps: {
  db: PostgresJsDatabase<Record<string, unknown>>;
  now?: () => Date;
}): PaperVenuePort {
  const now = deps.now ?? (() => new Date());

  async function readPaperConnection(billingAccountId: string): Promise<{
    id: string;
    funderAddress: string | null;
    paperSeedUsdc: string | null;
    tradingApprovalsReadyAt: Date | null;
  } | null> {
    const rows = await deps.db
      .select({
        id: polyWalletConnections.id,
        funderAddress: polyWalletConnections.funderAddress,
        paperSeedUsdc: polyWalletConnections.paperSeedUsdc,
        tradingApprovalsReadyAt: polyWalletConnections.tradingApprovalsReadyAt,
      })
      .from(polyWalletConnections)
      .where(
        and(
          eq(polyWalletConnections.billingAccountId, billingAccountId),
          // PAPER_ROWS_ONLY.
          eq(polyWalletConnections.kind, PAPER_CONNECTION_KIND),
          isNull(polyWalletConnections.revokedAt)
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async resolveAccount(
      billingAccountId: string
    ): Promise<PaperAccountIdentity> {
      let row: Awaited<ReturnType<typeof readPaperConnection>>;
      try {
        row = await readPaperConnection(billingAccountId);
      } catch (err) {
        throw new PaperAccountUnavailableError(
          billingAccountId,
          "backend_unreachable",
          err
        );
      }
      if (!row) {
        throw new PaperAccountUnavailableError(
          billingAccountId,
          "no_connection"
        );
      }
      // `provisionPaperAccount` writes both columns on every paper row, and
      // 0082's `paper_requires_seed` CHECK holds the seed non-null. A NULL
      // here means the row was hand-written around both — surface it instead
      // of substituting a value.
      if (!row.funderAddress || row.paperSeedUsdc === null) {
        throw new PaperAccountUnavailableError(
          billingAccountId,
          "no_connection"
        );
      }
      return {
        connectionId: row.id,
        funderAddress: row.funderAddress as `0x${string}`,
        seedUsdc: row.paperSeedUsdc,
      };
    },

    async authorizeIntent(
      billingAccountId: string,
      intent: OrderIntentSummary
    ): Promise<PaperAuthorizeResult> {
      try {
        const connection = await readPaperConnection(billingAccountId);
        if (!connection) return { ok: false, reason: "no_connection" };

        const grantRows = await deps.db
          .select({
            id: polyWalletGrants.id,
            scopes: polyWalletGrants.scopes,
            perOrderUsdcCap: polyWalletGrants.perOrderUsdcCap,
            dailyUsdcCap: polyWalletGrants.dailyUsdcCap,
            hourlyFillsCap: polyWalletGrants.hourlyFillsCap,
            expiresAt: polyWalletGrants.expiresAt,
          })
          .from(polyWalletGrants)
          .where(
            and(
              eq(polyWalletGrants.billingAccountId, billingAccountId),
              eq(polyWalletGrants.walletConnectionId, connection.id),
              isNull(polyWalletGrants.revokedAt)
            )
          )
          .orderBy(desc(polyWalletGrants.createdAt))
          .limit(1);

        const grantRow = grantRows[0];
        const grant: PaperGrantFacts | null = grantRow
          ? {
              id: grantRow.id,
              scopes: grantRow.scopes,
              perOrderUsdcCap: Number(grantRow.perOrderUsdcCap),
              dailyUsdcCap: Number(grantRow.dailyUsdcCap),
              hourlyFillsCap: grantRow.hourlyFillsCap,
              expiresAt: grantRow.expiresAt,
            }
          : null;

        const preconditions = evaluatePaperGrantPreconditions({
          intent,
          tradingApprovalsReadyAt: connection.tradingApprovalsReadyAt,
          grant,
          now: now(),
        });
        if (!preconditions.ok || grant === null) return preconditions;

        // CAPS_COUNT_INTENTS + CAP_WINDOWS_ARE_MODE_SCOPED. Filter on
        // `created_at` (intent insertion), not `observed_at` (upstream fill
        // time), so replayed historical target activity cannot backdate caps.
        const [spendRow] = await deps.db
          .select({
            spent: sum(
              sql<string>`COALESCE((${polyCopyTradeFills.attributes}->>'size_usdc')::numeric, 0)`
            ),
          })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, billingAccountId),
              eq(polyCopyTradeFills.mode, PAPER_LEDGER_MODE),
              gte(
                polyCopyTradeFills.createdAt,
                sql`now() - interval '24 hours'`
              ),
              inArray(polyCopyTradeFills.status, [...IN_FLIGHT_FILL_STATUSES])
            )
          );

        const [rateRow] = await deps.db
          .select({ n: count() })
          .from(polyCopyTradeFills)
          .where(
            and(
              eq(polyCopyTradeFills.billingAccountId, billingAccountId),
              eq(polyCopyTradeFills.mode, PAPER_LEDGER_MODE),
              gte(polyCopyTradeFills.createdAt, sql`now() - interval '1 hour'`),
              inArray(polyCopyTradeFills.status, [...IN_FLIGHT_FILL_STATUSES])
            )
          );

        return evaluatePaperCapWindows({
          intent,
          grant,
          spent24hUsdc: Number(spendRow?.spent ?? 0),
          fillsLastHour: Number(rateRow?.n ?? 0),
        });
      } catch {
        // FAIL_CLOSED — identical to the live adapter: any DB failure denies.
        return { ok: false, reason: "backend_unreachable" };
      }
    },
  };
}
