// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/paper-fact-source`
 * Purpose: The second fact source for `poly_trader_*`. Projects a paper
 *   account's simulated trading into the SAME tables the Data-API observer
 *   writes — `poly_trader_fills`, `poly_trader_position_snapshots`,
 *   `poly_trader_current_positions` — plus the tenant's
 *   `poly_wallet_balance_snapshots` NAV row, so every existing DB-only reader
 *   works unchanged with no paper-specific branch.
 * Scope: Feature service. Caller injects the DB handle, the logger, and the
 *   mid-price reader, and owns the statement timeout and transaction. Does not
 *   construct clients, read env, or schedule itself.
 * Invariants:
 *   - SAME_TABLES_NOT_A_MIRROR (migration 0083): paper writes the existing
 *     fact tables under `poly_trader_wallets.kind = 'paper_wallet'` and
 *     `poly_trader_fills.source = 'paper-ledger'`. A parallel
 *     `poly_paper_trader_*` table set is forbidden — it would be a second
 *     reader code path, which is the bug 0082/0083 exist to remove.
 *   - LEDGER_IS_THE_AUTHORITY: a paper account has no chain presence, so the
 *     Polygon CTF `balanceOfBatch` authority (`PositionBalanceBatchReader`) is
 *     never consulted on this path and `authority_unavailable` is never
 *     produced. Closure is DERIVED (`net_shares <= 0`), not inferred from an
 *     upstream omission, so the question the authority answers — "did this
 *     position really close, or did the Data-API just drop it?" — cannot arise.
 *     Reusing the live path here would have reported `authority_unavailable`
 *     for every paper tick and blocked publication entirely.
 *   - PROJECT_ONLY_TERMINAL_REALIZED: only ledger rows whose `status` is
 *     terminal (`filled` / `canceled` / `error`) AND which carry realized
 *     `price` + `shares` are projected. A resting `pending`/`open`/`partial`
 *     row's realized portion can still grow, and `poly_trader_fills` is an
 *     append-only immutable-event table with an `ON CONFLICT DO NOTHING`
 *     writer plus an additive `(created_at, id)`-watermarked rollup
 *     accumulator — projecting a mutable row would freeze its first-seen size
 *     and silently desynchronise `poly_trader_fill_rollups_daily`.
 *   - NO_FABRICATED_VALUES (docs/spec/capability-plane.md): an open position
 *     whose mid price cannot be read is NOT marked to 0 and NOT published; its
 *     prior row is preserved, the position cursor records `partial` with the
 *     reason, and the NAV row is withheld for that tick. A withheld NAV reads
 *     as `missing` ("no observation yet"), which is true, instead of
 *     `available` at an invented number. A hardcoded 0 here is precisely the
 *     bug that made paper trading unreadable.
 *   - MARKED_AT_THE_LIVE_MID: only *execution* is simulated. Open positions are
 *     marked at the real CLOB midpoint, same as a live position
 *     (PAPER_DELEGATES_READS_TO_LIVE in `paper.adapter.ts`). This is a writer,
 *     not a render path, so the upstream read does not violate
 *     PAGE_LOAD_DB_ONLY / SAVED_FACTS_ONLY.
 *   - NAV_IS_CASH_PLUS_MARKS: `seed − bought + sold − fees + Σ(shares × mid)`.
 *     The seed comes from `poly_wallet_connections.paper_seed_usdc`
 *     (PAPER_SEED_DECLARED, migration 0082); nothing here defaults or infers
 *     a starting balance.
 *   - AGGREGATES_IN_SQL (bug.5012): the fills projection is a single
 *     `INSERT … SELECT` — zero ledger rows enter V8 — and the position rollup
 *     is a `GROUP BY (condition_id, token_id)` returning one row per position,
 *     never one row per fill.
 *   - EXPLICIT_TENANT_FILTER: `poly_trader_*` carry no tenant FK and therefore
 *     no RLS; the capability plane is their only clamp. Every statement below
 *     binds `trader_wallet_id` and/or `billing_account_id` explicitly. There
 *     is no database backstop behind these queries.
 *   - DERIVED_ADDRESS_IS_CROSS_CHECKED: the synthetic address is recomputed
 *     from the billing account and compared to the stored row; a mismatch
 *     skips the account loudly rather than observing an address that two
 *     derivations disagree on (the live-path drift OBSERVE_WHAT_THE_EXECUTOR_
 *     SIGNS_FROM was written for).
 * Side-effects: IO — DB reads/writes through the injected handle, plus one
 *   CLOB midpoint read per open position token.
 * Links: docs/spec/capability-plane.md, docs/spec/poly-copy-trade-execution.md,
 *   migration 0082, migration 0083
 * @public
 */

import { createHash } from "node:crypto";
import { polyWalletConnections } from "@cogni/db-schema/wallet-connections";
import type { LoggerPort } from "@cogni/poly-market-provider";
import {
  polyTraderCurrentPositions,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { derivePaperAccountAddress } from "@/features/paper-accounts";
import { persistWalletBalanceFact } from "./wallet-balance-snapshot-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/**
 * `poly_trader_wallets.kind` for a paper account (migration 0083).
 *
 * KIND_ROUTES_THE_OBSERVER: this is the single field the observation tick
 * branches on, and it is also what keeps the two retirement sweeps disjoint —
 * `disableMissingTenantWallets` filters `kind = 'cogni_wallet'` and so cannot
 * retire a paper wallet, while {@link retireMissingPaperWallets} filters this
 * value and cannot retire a live one.
 */
export const PAPER_WALLET_KIND = "paper_wallet";

/** `poly_trader_fills.source` for a projected paper fill (migration 0083). */
export const PAPER_FILL_SOURCE = "paper-ledger";

/** `poly_trader_ingestion_cursors.source` for the fills projection. */
export const PAPER_TRADE_CURSOR_SOURCE = "paper-ledger-trades";

/** `poly_trader_ingestion_cursors.source` for the position projection. */
export const PAPER_POSITION_CURSOR_SOURCE = "paper-ledger-positions";

/**
 * Label on the enrolled wallet row. Distinct from the live
 * `"Tenant trading wallet"` label so the two populations are legible in the
 * observed-wallet list, but — unlike the live sweep — nothing *routes* on it.
 */
export const PAPER_TRADER_WALLET_LABEL = "Paper trading account";

/**
 * Ledger statuses whose realized `price`/`shares` are frozen.
 * See PROJECT_ONLY_TERMINAL_REALIZED. `canceled` and `error` are included
 * because a cancel-after-partial still realized shares
 * (CAP_COUNTS_REALIZED_ON_CANCEL in `order-ledger.ts`); the realized-columns
 * predicate is what filters out the ones that realized nothing.
 */
const TERMINAL_LEDGER_STATUSES = ["filled", "canceled", "error"] as const;

/**
 * `(…)` list for the status predicate, each value bound as a parameter.
 * A module constant, but bound rather than inlined so the shape stays
 * injection-proof if the list ever becomes caller-supplied.
 */
function terminalStatusList() {
  return sql`(${sql.join(
    TERMINAL_LEDGER_STATUSES.map((status) => sql`${status}`),
    sql`, `
  )})`;
}

/**
 * Overlap applied to the projection watermark. The watermark advances to
 * `max(updated_at)` of the rows projected, but a concurrently-committing
 * transaction can land a row with an *earlier* `updated_at` than one already
 * projected, which a strict `>` watermark would skip forever. Re-reading a
 * minute of already-projected rows is free: the writer is
 * `ON CONFLICT DO NOTHING` on `(trader_wallet_id, source, native_id)`.
 */
const PROJECTION_WATERMARK_OVERLAP_MS = 60_000;

/** Scale of every USDC-denominated numeric column written here. */
const USDC_SCALE = 8;

/**
 * Reads the current midpoint for one CTF token as a probability in `(0, 1)`,
 * or `null` when it cannot be read.
 *
 * `null` means UNKNOWN and is never coerced to 0 — see NO_FABRICATED_VALUES.
 * Production binds `PolymarketClobPublicClient.getMidpoint`.
 */
export type PaperMidPriceReader = (
  tokenId: string,
  signal?: AbortSignal
) => Promise<number | null>;

/** One active paper account, as the observation tick needs it. */
export type PaperAccount = {
  billingAccountId: string;
  /** The synthetic deterministic address, lowercased. */
  address: `0x${string}`;
  /** `paper_seed_usdc`, verbatim as a fixed-point string. */
  seedUsdc: string;
};

/** An enrolled paper wallet joined to the account it belongs to. */
export type EnrolledPaperWallet = {
  traderWalletId: string;
  account: PaperAccount;
};

export type PaperObservationResult = {
  /** Ledger rows newly projected into `poly_trader_fills`. */
  fills: number;
  /** `poly_trader_current_positions` rows written this tick. */
  positions: number;
  /** Open positions whose mid price could not be read (NAV withheld). */
  unpricedPositions: number;
  /** Whether the NAV row was published this tick. */
  navPublished: boolean;
};

/**
 * Every active paper account, keyed for enrollment.
 *
 * Reads `poly_wallet_connections` directly rather than going through
 * `PolyTraderWalletPort`. That is NOT a second derivation of the kind
 * OBSERVE_WHAT_THE_EXECUTOR_SIGNS_FROM forbids: a live row's trading identity
 * is ambiguous (signer EOA vs V2 funder, which is why the port must own it),
 * whereas a paper row's address has exactly one definition —
 * `derivePaperAccountAddress(billingAccountId)`, a pure function. We recompute
 * it and assert agreement with the stored row, so this path cannot drift onto
 * a different address than the one `provisionPaperAccount` wrote; it can only
 * fail loudly.
 *
 * Carries an explicit `kind = 'paper'` filter, so it can never return a live
 * connection even though both kinds now share the table
 * (KIND_IS_THE_DISCRIMINATOR, migration 0082).
 */
export async function readActivePaperAccounts(
  db: Db,
  logger: LoggerPort
): Promise<readonly PaperAccount[]> {
  const rows = await db
    .select({
      billingAccountId: polyWalletConnections.billingAccountId,
      address: polyWalletConnections.address,
      funderAddress: polyWalletConnections.funderAddress,
      paperSeedUsdc: polyWalletConnections.paperSeedUsdc,
    })
    .from(polyWalletConnections)
    .where(
      and(
        eq(polyWalletConnections.kind, "paper"),
        isNull(polyWalletConnections.revokedAt)
      )
    );

  return rows.flatMap((row) => {
    const expected = derivePaperAccountAddress(row.billingAccountId);
    const stored = row.address.toLowerCase();
    if (stored !== expected) {
      logger.error(
        {
          event: "poly.paper.account_address_mismatch",
          billing_account_id: row.billingAccountId,
          stored_address: stored,
          derived_address: expected,
        },
        "paper account address does not match its derivation — refusing to observe it"
      );
      return [];
    }
    // The funder is the trading identity every live reader drives from
    // (`readWalletBalanceFact` joins on `lower(funder_address)`), so a paper
    // row whose funder disagrees with its address would publish a NAV the
    // dashboard cannot find. Fail closed rather than pick one.
    if ((row.funderAddress ?? "").toLowerCase() !== expected) {
      logger.error(
        {
          event: "poly.paper.account_funder_mismatch",
          billing_account_id: row.billingAccountId,
          funder_address: row.funderAddress,
          derived_address: expected,
        },
        "paper account funder_address does not match its derivation — refusing to observe it"
      );
      return [];
    }
    // PAPER_SEED_DECLARED (migration 0082) makes this non-null for every paper
    // row at the DB level. If it is somehow null we cannot compute a NAV and
    // must not invent a starting balance.
    if (row.paperSeedUsdc === null) {
      logger.error(
        {
          event: "poly.paper.account_seed_missing",
          billing_account_id: row.billingAccountId,
        },
        "paper account has no declared seed balance — refusing to observe it"
      );
      return [];
    }
    return [
      {
        billingAccountId: row.billingAccountId,
        address: expected,
        seedUsdc: row.paperSeedUsdc,
      },
    ];
  });
}

/**
 * Enroll every active paper account as an observed wallet and retire the ones
 * that are gone. Returns the enrolled set keyed by `poly_trader_wallets.id`,
 * because the wallet row carries no `billing_account_id` and the projection
 * needs the tenant + seed to do anything.
 *
 * ENROLLMENT_FAILURE_IS_NOT_A_WIPE, strengthened: an EMPTY account list
 * retires nothing at all. The live `disableMissingTenantWallets` treats empty
 * as "retire every tenant wallet", which makes a transient reader outage
 * indistinguishable from a genuine mass-revoke. A revoked paper account is
 * retired on the next tick that reads a non-empty list, and in the meantime an
 * over-retained paper wallet is harmless (its projection is idempotent) while
 * an over-retired one loses the dashboard.
 */
export async function syncPaperTraderWallets(
  db: Db,
  accounts: readonly PaperAccount[],
  now = new Date()
): Promise<readonly EnrolledPaperWallet[]> {
  if (accounts.length === 0) return [];

  const enrolled = await db
    .insert(polyTraderWallets)
    .values(
      accounts.map((account) => ({
        walletAddress: account.address,
        kind: PAPER_WALLET_KIND,
        label: PAPER_TRADER_WALLET_LABEL,
        activeForResearch: true,
        disabledAt: null,
        updatedAt: now,
      }))
    )
    .onConflictDoUpdate({
      target: polyTraderWallets.walletAddress,
      set: {
        kind: PAPER_WALLET_KIND,
        label: PAPER_TRADER_WALLET_LABEL,
        activeForResearch: true,
        disabledAt: null,
        updatedAt: now,
      },
    })
    .returning({
      id: polyTraderWallets.id,
      walletAddress: polyTraderWallets.walletAddress,
    });

  await retireMissingPaperWallets(
    db,
    accounts.map((account) => account.address),
    now
  );

  const byAddress = new Map(
    accounts.map((account) => [account.address, account])
  );
  return enrolled.flatMap((row) => {
    const account = byAddress.get(row.walletAddress.toLowerCase());
    return account ? [{ traderWalletId: row.id, account }] : [];
  });
}

/**
 * Deactivate paper wallets whose account is no longer active.
 *
 * Filters `kind = PAPER_WALLET_KIND`, so this sweep is structurally incapable
 * of touching a `cogni_wallet` or `copy_target` row — the mirror of the
 * guarantee `disableMissingTenantWallets` gives in the other direction. Caller
 * guarantees a non-empty address list (see {@link syncPaperTraderWallets}).
 */
async function retireMissingPaperWallets(
  db: Db,
  activeAddresses: readonly string[],
  now: Date
): Promise<void> {
  if (activeAddresses.length === 0) return;
  await db
    .update(polyTraderWallets)
    .set({ activeForResearch: false, disabledAt: now, updatedAt: now })
    .where(
      and(
        eq(polyTraderWallets.kind, PAPER_WALLET_KIND),
        isNull(polyTraderWallets.disabledAt),
        notInArray(polyTraderWallets.walletAddress, [...activeAddresses])
      )
    );
}

/**
 * Project the tenant's terminal, realized paper ledger rows into
 * `poly_trader_fills`.
 *
 * One statement, `INSERT … SELECT`: no ledger row is ever hydrated into V8
 * (AGGREGATES_IN_SQL). The scan is bounded by one tenant's own ledger via the
 * leading `billing_account_id` predicate — served by
 * `poly_copy_trade_fills_pnl_idx (billing_account_id, target_id, market_id,
 * mode, status)` — and further narrowed by the `updated_at` watermark, so it
 * does not grow into the cross-wallet unbounded scan of bug.5012.
 *
 * `native_id` is `"<target_id>:<fill_id>"`. The ledger's PK is
 * `(billing_account_id, target_id, fill_id)` and `billing_account_id` is
 * already implied by the wallet, so that pair is the natural per-wallet
 * identity and makes the `(trader_wallet_id, source, native_id)` unique index
 * the idempotence gate.
 *
 * `side` and `token_id` come from `attributes` JSONB: the ledger has no such
 * columns (`market_id` is the conditionId). Rows missing either, or whose side
 * is not exactly BUY/SELL, are skipped — the `poly_trader_fills` CHECKs would
 * reject them anyway, and guessing a side is unthinkable.
 */
export async function projectPaperFills(input: {
  db: Db;
  traderWalletId: string;
  billingAccountId: string;
  /** `max(updated_at)` already projected, or null on the first run. */
  watermark: Date | null;
}): Promise<{ inserted: number; candidates: number; watermark: Date | null }> {
  const since = input.watermark
    ? new Date(input.watermark.getTime() - PROJECTION_WATERMARK_OVERLAP_MS)
    : null;

  const result = await input.db.execute(sql`
    WITH src AS (
      SELECT
        ${input.traderWalletId}::uuid AS trader_wallet_id,
        f.target_id,
        f.fill_id,
        f.client_order_id,
        f.order_id,
        f.status,
        f.fees_usdc,
        f.attributes,
        f.updated_at,
        f.observed_at,
        COALESCE(NULLIF(f.attributes->>'condition_id', ''), f.market_id) AS condition_id,
        f.attributes->>'token_id' AS token_id,
        f.attributes->>'side' AS side,
        f.price AS price,
        f.shares AS shares,
        round(f.price * f.shares, 8) AS size_usdc
      FROM poly_copy_trade_fills f
      WHERE f.billing_account_id = ${input.billingAccountId}
        AND f.mode = 'paper'
        AND f.status IN ${terminalStatusList()}
        AND f.price IS NOT NULL AND f.price > 0
        AND f.shares IS NOT NULL AND f.shares > 0
        AND round(f.price * f.shares, 8) > 0
        AND f.attributes->>'side' IN ('BUY', 'SELL')
        AND NULLIF(f.attributes->>'token_id', '') IS NOT NULL
        AND COALESCE(NULLIF(f.attributes->>'condition_id', ''), f.market_id) IS NOT NULL
        ${since ? sql`AND f.updated_at >= ${since.toISOString()}::timestamptz` : sql``}
    ),
    ins AS (
      INSERT INTO poly_trader_fills (
        trader_wallet_id, source, native_id, condition_id, token_id,
        side, price, shares, size_usdc, tx_hash, observed_at, raw
      )
      SELECT
        src.trader_wallet_id,
        ${PAPER_FILL_SOURCE},
        src.target_id::text || ':' || src.fill_id,
        src.condition_id,
        src.token_id,
        src.side,
        src.price,
        src.shares,
        src.size_usdc,
        -- Paper has no chain transaction. NULL, never a synthesised hash.
        NULL,
        src.observed_at,
        jsonb_build_object(
          'paper_ledger', jsonb_build_object(
            'target_id', src.target_id,
            'fill_id', src.fill_id,
            'client_order_id', src.client_order_id,
            'order_id', src.order_id,
            'status', src.status,
            'fees_usdc', src.fees_usdc
          ),
          'attributes', src.attributes
        )
      FROM src
      ON CONFLICT (trader_wallet_id, source, native_id) DO NOTHING
      RETURNING 1 AS projected
    )
    SELECT
      (SELECT count(*) FROM ins)::int AS inserted,
      (SELECT count(*) FROM src)::int AS candidates,
      (SELECT max(updated_at) FROM src) AS max_updated_at
  `);

  const row = firstRow<{
    inserted: number | string;
    candidates: number | string;
    max_updated_at: string | Date | null;
  }>(result);
  const advanced = row?.max_updated_at ?? null;
  return {
    inserted: Number(row?.inserted ?? 0),
    candidates: Number(row?.candidates ?? 0),
    // Never regress the watermark: a tick that matched nothing keeps the old
    // one rather than resetting to null and re-scanning all of history.
    watermark: advanced ? new Date(advanced) : input.watermark,
  };
}

/** One position's aggregate, straight out of SQL. */
type PaperPositionRollup = {
  conditionId: string;
  tokenId: string;
  netShares: number;
  buyShares: number;
  buyUsdc: number;
  sellUsdc: number;
  lastFillAt: Date;
};

/**
 * Aggregate this wallet's projected paper fills into one row per position.
 *
 * `GROUP BY (condition_id, token_id)` — the result is bounded by the account's
 * unique position count (tens), never by its fill count, so this is the
 * "small per-entity rollup" shape the data-research standard permits in V8.
 * Served by `poly_trader_fills_trader_observed_idx (trader_wallet_id,
 * observed_at)`.
 *
 * Average-cost convention: `avg_price` is the BUY-side VWAP and the remaining
 * position's cost basis is `net_shares × avg_price`. This matches what
 * Polymarket's Data-API reports for a live wallet (`avgPrice` / `initialValue`),
 * so a paper position and a live position mean the same thing to every reader.
 */
async function readPaperPositionRollups(
  db: Db,
  traderWalletId: string
): Promise<readonly PaperPositionRollup[]> {
  const result = await db.execute(sql`
    SELECT
      condition_id,
      token_id,
      SUM(CASE WHEN side = 'BUY' THEN shares ELSE -shares END) AS net_shares,
      COALESCE(SUM(shares)   FILTER (WHERE side = 'BUY'),  0) AS buy_shares,
      COALESCE(SUM(size_usdc) FILTER (WHERE side = 'BUY'),  0) AS buy_usdc,
      COALESCE(SUM(size_usdc) FILTER (WHERE side = 'SELL'), 0) AS sell_usdc,
      MAX(observed_at) AS last_fill_at
    FROM poly_trader_fills
    WHERE trader_wallet_id = ${traderWalletId}::uuid
      AND source = ${PAPER_FILL_SOURCE}
    GROUP BY condition_id, token_id
  `);
  return allRows<{
    condition_id: string;
    token_id: string;
    net_shares: string;
    buy_shares: string;
    buy_usdc: string;
    sell_usdc: string;
    last_fill_at: string | Date;
  }>(result).map((row) => ({
    conditionId: row.condition_id,
    tokenId: row.token_id,
    netShares: Number(row.net_shares),
    buyShares: Number(row.buy_shares),
    buyUsdc: Number(row.buy_usdc),
    sellUsdc: Number(row.sell_usdc),
    lastFillAt: new Date(row.last_fill_at),
  }));
}

/**
 * Total simulated fees the tenant's projected paper rows realized.
 *
 * Separate from {@link readPaperPositionRollups} because `poly_trader_fills`
 * has no fees column and must not get one — `size_usdc` is notional, and
 * folding fees into it would corrupt a fact every live reader shares. One
 * extra single-row aggregate over the same tenant-filtered, terminal,
 * realized ledger slice.
 *
 * Also counts rows whose `fees_usdc` is NULL. A NULL fee is "the sidecar did
 * not report one", which is NOT a zero — the count is surfaced on the NAV row's
 * `errors` so the total is never silently understated.
 */
async function readPaperFeesUsdc(
  db: Db,
  billingAccountId: string
): Promise<{ feesUsdc: number; rowsMissingFees: number }> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM(f.fees_usdc), 0) AS fees_usdc,
      count(*) FILTER (WHERE f.fees_usdc IS NULL)::int AS rows_missing_fees
    FROM poly_copy_trade_fills f
    WHERE f.billing_account_id = ${billingAccountId}
      AND f.mode = 'paper'
      AND f.status IN ${terminalStatusList()}
      AND f.price IS NOT NULL AND f.price > 0
      AND f.shares IS NOT NULL AND f.shares > 0
  `);
  const row = firstRow<{ fees_usdc: string; rows_missing_fees: number }>(result);
  return {
    feesUsdc: Number(row?.fees_usdc ?? 0),
    rowsMissingFees: Number(row?.rows_missing_fees ?? 0),
  };
}

/**
 * Content hash for snapshot dedupe, mirroring {@link hashPosition}'s contract
 * exactly: position-DEFINING fields only.
 *
 * `currentValueUsdc` is deliberately excluded. Including the mark would make
 * every tick of an open position in a liquid market write a fresh snapshot row
 * (~2880/day/position at a 30s cadence) because the mid always moves — the
 * same blowup task.5012 fixed on the live path. A snapshot row means "the
 * position itself changed"; live marks live in `poly_trader_current_positions`.
 */
function hashPaperPosition(input: {
  conditionId: string;
  tokenId: string;
  shares: string;
  avgPrice: string;
  costBasisUsdc: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        conditionId: input.conditionId,
        tokenId: input.tokenId,
        shares: input.shares,
        avgPrice: input.avgPrice,
        costBasisUsdc: input.costBasisUsdc,
      })
    )
    .digest("hex");
}

/** A position row ready to write, plus whether it still needs a mark. */
type PreparedPaperPosition = {
  conditionId: string;
  tokenId: string;
  active: boolean;
  shares: string;
  costBasisUsdc: string;
  currentValueUsdc: string;
  avgPrice: string;
  contentHash: string;
  raw: Record<string, unknown>;
};

/**
 * Project positions and publish the NAV row.
 *
 * Writes `poly_trader_position_snapshots` + `poly_trader_current_positions`
 * with the exact conflict keys the live writer uses, then — only if every open
 * position could be marked — the tenant's `poly_wallet_balance_snapshots` row.
 * That NAV row is what makes the dashboard render at all:
 * `readWalletBalanceFact` drives from `poly_wallet_connections` and left-joins
 * this table on `lower(address) = lower(funder_address)`, returning
 * `available` only when the row exists.
 */
export async function projectPaperPositionsAndNav(input: {
  db: Db;
  wallet: EnrolledPaperWallet;
  readMidPrice: PaperMidPriceReader;
  logger: LoggerPort;
  signal?: AbortSignal | undefined;
  now?: Date;
}): Promise<{
  positions: number;
  unpricedPositions: number;
  navPublished: boolean;
}> {
  const now = input.now ?? new Date();
  const { traderWalletId, account } = input.wallet;
  const rollups = await readPaperPositionRollups(input.db, traderWalletId);

  const prepared: PreparedPaperPosition[] = [];
  const unpriced: { conditionId: string; tokenId: string }[] = [];
  const incoherent: { conditionId: string; tokenId: string }[] = [];
  let openValueUsdc = 0;
  let boughtUsdc = 0;
  let soldUsdc = 0;

  for (const rollup of rollups) {
    boughtUsdc += rollup.buyUsdc;
    soldUsdc += rollup.sellUsdc;

    // Clamp at zero: the CHECKs on both tables require shares >= 0, and a
    // negative net is over-selling, which CTF cannot represent. Treated as
    // fully closed and logged below if it actually went negative.
    const openShares = rollup.netShares > 0 ? rollup.netShares : 0;
    const avgPrice = rollup.buyShares > 0 ? rollup.buyUsdc / rollup.buyShares : 0;

    if (openShares > 0 && rollup.buyShares <= 0) {
      // Held shares with no BUY to derive an entry price from. There is no
      // honest cost basis here and we will not invent one.
      incoherent.push({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
      });
      continue;
    }

    if (openShares === 0) {
      // A closed position is worth zero because it holds zero shares — that is
      // arithmetic, not a fabricated mark, so it needs no mid price.
      // `avg_price` keeps the real entry VWAP rather than being zeroed: it is a
      // fact we know, and the live path only zeroes it because the position
      // vanished from upstream with no history to keep.
      const shares = "0";
      const costBasisUsdc = "0";
      const avgPriceStr = avgPrice.toFixed(USDC_SCALE);
      prepared.push({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
        active: false,
        shares,
        costBasisUsdc,
        currentValueUsdc: "0",
        avgPrice: avgPriceStr,
        contentHash: hashPaperPosition({
          conditionId: rollup.conditionId,
          tokenId: rollup.tokenId,
          shares,
          avgPrice: avgPriceStr,
          costBasisUsdc,
        }),
        raw: paperPositionRaw(rollup, null, 0),
      });
      continue;
    }

    const mid = await input.readMidPrice(rollup.tokenId, input.signal);
    if (mid === null) {
      // NO_FABRICATED_VALUES: leave the existing row untouched and withhold the
      // NAV. Writing 0 here is the bug; writing a stale-but-real prior mark and
      // saying so is the fix.
      unpriced.push({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
      });
      continue;
    }

    const shares = openShares.toFixed(USDC_SCALE);
    const costBasisUsdc = (openShares * avgPrice).toFixed(USDC_SCALE);
    const avgPriceStr = avgPrice.toFixed(USDC_SCALE);
    const currentValue = openShares * mid;
    openValueUsdc += currentValue;
    prepared.push({
      conditionId: rollup.conditionId,
      tokenId: rollup.tokenId,
      active: true,
      shares,
      costBasisUsdc,
      currentValueUsdc: currentValue.toFixed(USDC_SCALE),
      avgPrice: avgPriceStr,
      contentHash: hashPaperPosition({
        conditionId: rollup.conditionId,
        tokenId: rollup.tokenId,
        shares,
        avgPrice: avgPriceStr,
        costBasisUsdc,
      }),
      raw: paperPositionRaw(rollup, mid, currentValue),
    });
  }

  if (incoherent.length > 0) {
    input.logger.error(
      {
        event: "poly.paper.position_incoherent",
        trader_wallet_id: traderWalletId,
        billing_account_id: account.billingAccountId,
        positions: incoherent.length,
        sample: incoherent.slice(0, 5),
      },
      "paper position holds shares with no BUY fills — no cost basis can be derived; skipped"
    );
  }

  if (prepared.length > 0) {
    await writePaperPositionRows(input.db, traderWalletId, prepared, now);
  }

  const fees = await readPaperFeesUsdc(input.db, account.billingAccountId);
  const seedUsdc = Number(account.seedUsdc);

  // NAV_IS_CASH_PLUS_MARKS. Withheld whenever any open position is unmarked or
  // incoherent, because the total would then silently omit that exposure.
  const navBlockers = unpriced.length + incoherent.length;
  const navPublishable = navBlockers === 0 && Number.isFinite(seedUsdc);
  if (navPublishable) {
    const nav = seedUsdc - boughtUsdc + soldUsdc - fees.feesUsdc + openValueUsdc;
    await publishPaperNav({
      db: input.db,
      account,
      // A NAV below zero cannot be represented: the snapshot's `nonnegative`
      // CHECK rejects it. It also cannot happen under correct cap accounting,
      // so it is a loud clamp, not a silent one.
      navUsdc: nav,
      rowsMissingFees: fees.rowsMissingFees,
      logger: input.logger,
      observedAt: now,
    });
  } else {
    input.logger.warn(
      {
        event: "poly.paper.nav_withheld",
        trader_wallet_id: traderWalletId,
        billing_account_id: account.billingAccountId,
        unpriced_positions: unpriced.length,
        incoherent_positions: incoherent.length,
        seed_usdc_finite: Number.isFinite(seedUsdc),
        sample_unpriced: unpriced.slice(0, 5),
      },
      "paper NAV withheld — an open position could not be marked; publishing a partial total would invent a value"
    );
  }

  await publishPaperPositionCursor({
    db: input.db,
    traderWalletId,
    status: navBlockers === 0 ? "ok" : "partial",
    errorMessage:
      navBlockers === 0
        ? null
        : `${unpriced.length} open position(s) had no readable mid price and ${incoherent.length} had no derivable cost basis; NAV withheld`,
    observedAt: now,
  });

  return {
    positions: prepared.length,
    unpricedPositions: unpriced.length,
    navPublished: navPublishable,
  };
}

/**
 * The `raw` payload stored alongside a projected position.
 *
 * Deliberately records the inputs the aggregate was computed FROM, so a reader
 * can audit the number without re-deriving it — the persisted-payload
 * discipline the data-research standard asks for (bug.5020). `mid` is null for
 * a closed position, which carries no mark by construction.
 */
function paperPositionRaw(
  rollup: PaperPositionRollup,
  mid: number | null,
  currentValue: number
): Record<string, unknown> {
  return {
    source: PAPER_FILL_SOURCE,
    conditionId: rollup.conditionId,
    asset: rollup.tokenId,
    netShares: rollup.netShares,
    buyShares: rollup.buyShares,
    buyUsdc: rollup.buyUsdc,
    sellUsdc: rollup.sellUsdc,
    curPrice: mid,
    currentValue,
    lastFillAt: rollup.lastFillAt.toISOString(),
  };
}

/**
 * Write the snapshot + current-position rows, honouring the live writer's
 * conflict keys exactly: snapshots dedupe on
 * `(trader_wallet_id, condition_id, token_id, content_hash)`, current
 * positions upsert on the PK `(trader_wallet_id, condition_id, token_id)`.
 */
async function writePaperPositionRows(
  db: Db,
  traderWalletId: string,
  prepared: readonly PreparedPaperPosition[],
  capturedAt: Date
): Promise<void> {
  await db
    .insert(polyTraderPositionSnapshots)
    .values(
      prepared.map((position) => ({
        traderWalletId,
        conditionId: position.conditionId,
        tokenId: position.tokenId,
        shares: position.shares,
        costBasisUsdc: position.costBasisUsdc,
        currentValueUsdc: position.currentValueUsdc,
        avgPrice: position.avgPrice,
        contentHash: position.contentHash,
        capturedAt,
        raw: position.raw,
      }))
    )
    .onConflictDoNothing({
      target: [
        polyTraderPositionSnapshots.traderWalletId,
        polyTraderPositionSnapshots.conditionId,
        polyTraderPositionSnapshots.tokenId,
        polyTraderPositionSnapshots.contentHash,
      ],
    });

  await db
    .insert(polyTraderCurrentPositions)
    .values(
      prepared.map((position) => ({
        traderWalletId,
        conditionId: position.conditionId,
        tokenId: position.tokenId,
        active: position.active,
        shares: position.shares,
        costBasisUsdc: position.costBasisUsdc,
        currentValueUsdc: position.currentValueUsdc,
        avgPrice: position.avgPrice,
        contentHash: position.contentHash,
        lastObservedAt: capturedAt,
        raw: position.raw,
      }))
    )
    .onConflictDoUpdate({
      target: [
        polyTraderCurrentPositions.traderWalletId,
        polyTraderCurrentPositions.conditionId,
        polyTraderCurrentPositions.tokenId,
      ],
      set: {
        active: sql`excluded.active`,
        shares: sql`excluded.shares`,
        costBasisUsdc: sql`excluded.cost_basis_usdc`,
        currentValueUsdc: sql`excluded.current_value_usdc`,
        avgPrice: sql`excluded.avg_price`,
        contentHash: sql`excluded.content_hash`,
        lastObservedAt: capturedAt,
        raw: sql`excluded.raw`,
      },
    });
}

/**
 * Publish the tenant's NAV as a `poly_wallet_balance_snapshots` row.
 *
 * Why `usdc_e` carries the NAV and the other two legs are NULL: the table's
 * `status_values` CHECK admits exactly three shapes — `ok` with all three legs
 * non-null, `partial` with one or two, `error` with none. A paper account has
 * no on-chain pUSD and no POL, and it never will. Writing `0` for them to
 * reach `ok` would assert two measurements that were never taken; NULL plus a
 * `partial` status plus an explicit `errors` entry says what is true, and
 * `readWalletBalanceFact` returns `available` for `partial` just as it does for
 * `ok`, so the dashboard renders either way. `paper_seed_usdc`'s own docstring
 * pins its precision to `usdc_e`, which is the column task A intended.
 *
 * Reuses `persistWalletBalanceFact`, so the status classification and the
 * `billing_account_id` PK upsert are shared with the live Polygon writer
 * rather than re-implemented.
 */
async function publishPaperNav(input: {
  db: Db;
  account: PaperAccount;
  navUsdc: number;
  rowsMissingFees: number;
  logger: LoggerPort;
  observedAt: Date;
}): Promise<void> {
  const errors = [
    "Simulated account: the reported collateral is paper NAV (seed − cost + marked open positions), not an on-chain balance.",
    "On-chain pUSD and POL balances are not reported for a paper account — it has no chain presence.",
  ];
  if (input.rowsMissingFees > 0) {
    errors.push(
      `${input.rowsMissingFees} realized paper fill(s) reported no fee value; NAV treats their fees as unreported, not as zero.`
    );
  }
  let nav = input.navUsdc;
  if (!(nav >= 0)) {
    input.logger.error(
      {
        event: "poly.paper.nav_negative",
        billing_account_id: input.account.billingAccountId,
        nav_usdc: input.navUsdc,
      },
      "paper NAV computed negative — clamping to 0 for the nonnegative CHECK; cap accounting is wrong upstream"
    );
    errors.push(
      `NAV computed negative (${input.navUsdc}) and was clamped to 0 — treat this account's totals as unreliable.`
    );
    nav = 0;
  }
  await persistWalletBalanceFact(
    input.db,
    {
      billingAccountId: input.account.billingAccountId,
      address: input.account.address,
      usdcE: Number(nav.toFixed(USDC_SCALE)),
      pusd: null,
      pol: null,
      errors,
    },
    input.observedAt
  );
}

/** Advance (or fault) the paper position cursor, same shape as the live one. */
async function publishPaperPositionCursor(input: {
  db: Db;
  traderWalletId: string;
  status: "ok" | "partial";
  errorMessage: string | null;
  observedAt: Date;
}): Promise<void> {
  await input.db
    .insert(polyTraderIngestionCursors)
    .values({
      traderWalletId: input.traderWalletId,
      source: PAPER_POSITION_CURSOR_SOURCE,
      lastSuccessAt: input.observedAt,
      status: input.status,
      errorMessage: input.errorMessage,
      updatedAt: input.observedAt,
    })
    .onConflictDoUpdate({
      target: [
        polyTraderIngestionCursors.traderWalletId,
        polyTraderIngestionCursors.source,
      ],
      set: {
        lastSuccessAt: input.observedAt,
        status: sql`excluded.status`,
        errorMessage: sql`excluded.error_message`,
        updatedAt: input.observedAt,
      },
    });
}

/**
 * Observe one paper wallet: project fills, aggregate + mark positions, publish
 * NAV. The paper analogue of `observeWallet`.
 *
 * Never touches `PolymarketDataApiClient` and never consults
 * `PositionBalanceBatchReader` — see LEDGER_IS_THE_AUTHORITY. The caller owns
 * the statement timeout, exactly as it does for the live path.
 */
export async function observePaperWallet(input: {
  db: Db;
  wallet: EnrolledPaperWallet;
  readMidPrice: PaperMidPriceReader;
  logger: LoggerPort;
  signal?: AbortSignal | undefined;
  now?: Date;
}): Promise<PaperObservationResult> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const { traderWalletId, account } = input.wallet;

  const cursor = await input.db
    .select({ lastSeenAt: polyTraderIngestionCursors.lastSeenAt })
    .from(polyTraderIngestionCursors)
    .where(
      and(
        eq(polyTraderIngestionCursors.traderWalletId, traderWalletId),
        eq(polyTraderIngestionCursors.source, PAPER_TRADE_CURSOR_SOURCE)
      )
    )
    .limit(1);

  const projected = await projectPaperFills({
    db: input.db,
    traderWalletId,
    billingAccountId: account.billingAccountId,
    watermark: cursor[0]?.lastSeenAt ?? null,
  });

  await input.db
    .insert(polyTraderIngestionCursors)
    .values({
      traderWalletId,
      source: PAPER_TRADE_CURSOR_SOURCE,
      lastSeenAt: projected.watermark,
      lastSuccessAt: now,
      status: "ok",
      errorMessage: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        polyTraderIngestionCursors.traderWalletId,
        polyTraderIngestionCursors.source,
      ],
      set: {
        lastSeenAt: sql`excluded.last_seen_at`,
        lastSuccessAt: now,
        status: "ok",
        errorMessage: null,
        updatedAt: now,
      },
    });

  const positions = await projectPaperPositionsAndNav({
    db: input.db,
    wallet: input.wallet,
    readMidPrice: input.readMidPrice,
    logger: input.logger,
    signal: input.signal,
    now,
  });

  input.logger.info(
    {
      event: "poly.paper.observe",
      phase: "wallet_ok",
      trader_wallet_id: traderWalletId,
      billing_account_id: account.billingAccountId,
      wallet: account.address,
      fills: projected.inserted,
      fill_candidates: projected.candidates,
      positions: positions.positions,
      unpriced_positions: positions.unpricedPositions,
      nav_published: positions.navPublished,
      duration_ms: Date.now() - startedAt,
    },
    "paper wallet observed"
  );

  return {
    fills: projected.inserted,
    positions: positions.positions,
    unpricedPositions: positions.unpricedPositions,
    navPublished: positions.navPublished,
  };
}

/**
 * `db.execute` result shape differs between the node-postgres and postgres-js
 * drivers (`{ rows }` vs a bare array). Same normalisation the observation
 * service's `executionRows` does; duplicated rather than imported to keep this
 * module free of a cycle back into `trader-observation-service`.
 */
function allRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function firstRow<T>(result: unknown): T | undefined {
  return allRows<T>(result)[0];
}
