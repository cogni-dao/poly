// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/wallet-analysis-service`
 * Purpose: Service layer feeding `/api/v1/poly/wallets/[addr]` (snapshot, trades, balance, pnl slices) and `/api/v1/poly/wallet/execution` (live/closed position split). Every render-path slice is a DB-only saved-facts read; upstream Data API/CLOB/user-P&L calls belong to observation jobs and explicit refresh mutations.
 * Scope: Compute + I/O only. Does not authenticate, does not parse HTTP. Returns Zod-validated slice values per the wallet-analysis v1 and execution v1 contracts.
 * Invariants:
 *   - REUSE_PACKAGE_CLIENTS: all upstream HTTP goes through `@cogni/poly-market-provider` clients — no fetch in this file.
 *   - DETERMINISTIC_METRICS: snapshot winrate, duration, and activity math is identical to `computeWalletMetrics` (spike.0323 v3). Current open-position count/cost come from the saved current-position model because a forward-only fill corpus cannot reconstruct pre-enrollment holdings. PnL-class outputs (`realizedPnlUsdc` etc.) of `computeWalletMetrics` are deliberately not surfaced; PnL is sourced from the `pnl` slice (task.0389).
 *   - PNL_NOT_IN_SNAPSHOT: `getSnapshotSlice` does not return any PnL field. Headline PnL on the wallet research surface is derived from `getPnlSlice` (DB-backed `poly_trader_user_pnl_points`, written by the trader-observation tick) — single source, reconciles with the chart by construction.
 *   - PAGE_LOAD_DB_ONLY (task.5012): every slice except `getExecutionSlice`'s CLOB price-history call is DB-only. `getPnlSlice` reads `poly_trader_user_pnl_points`; `getTradesSlice` + `getSnapshotSlice` + `getDistributionsSlice` read `poly_trader_fills` + `poly_market_outcomes`; `getBalanceSlice` + `getExecutionSlice` read `poly_trader_current_positions` + `poly_trader_fills`. Conditions absent from `poly_market_outcomes` are treated as unresolved (open positions).
 *   - PAGE_LOAD_DB_ONLY_EXCEPT_PRICE_HISTORY (task.5012 CP5): `getExecutionSlice` still calls CLOB `getPriceHistory` per open position — bounded v0 carve-out, removed by CP7's `poly_market_price_history` mirror.
 *   - PARTIAL_FAILURE_NEVER_THROWS: each slice returns a `{ value | warning }` result; the route surfaces warnings without 5xx-ing.
 *   - CLOB_HISTORY_OPEN_ONLY: `getPriceHistory` is fetched only for open/redeemable positions; closed positions use trade-derived timelines only.
 *   - PAGE_LOAD_DB_ONLY (task.5018 CP7): `getExecutionSlice` reads price-history from `poly_market_price_history` (DB-backed). The price-history bootstrap job is the only writer. Closes the `PAGE_LOAD_DB_ONLY_EXCEPT_PRICE_HISTORY` carve-out from CP5 — every wallet-analysis page-load surface is now DB-only.
 *   - ROLLUP_BACKED_SNAPSHOT (task.research-rollup-read-models): `getSnapshotSlice`'s per-position aggregate and 30-day activity count read `poly_trader_fill_rollups_daily` (+ unrolled tail) via `fill-rollup-service` — no full fills-history scan on the request path. Parity vs the legacy full-scan SQL is enforced by the component rollup parity suite.
 * Side-effects: IO (DB reads only post-CP7; trader-observation + market-outcome + price-history ticks are the only writers).
 * Notes: Cache is process-scoped — see `instrumentation.ts` single-replica boot assert.
 * Links: docs/design/wallet-analysis-components.md, nodes/poly/packages/market-provider/src/analysis/wallet-metrics.ts, nodes/poly/packages/node-contracts/src/poly.wallet-analysis.v1.contract.ts, nodes/poly/packages/node-contracts/src/poly.wallet.execution.v1.contract.ts, work/items/task.5012, work/items/task.5015
 * @public
 */

import {
  polyMarketMetadata,
  polyMarketOutcomes,
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderIngestionCursors,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import type {
  PolymarketClobPublicClient,
  PolymarketUserPosition,
  PolymarketUserTrade,
} from "@cogni/poly-market-provider/adapters/polymarket";
import {
  type MarketResolutionInput,
  mapExecutionPositions,
  type OrderFlowTrade,
  summariseOrderFlow,
} from "@cogni/poly-market-provider/analysis";
import type {
  PolyWalletExecutionOutput,
  PolyWalletOverviewInterval,
  WalletAnalysisBalance,
  WalletAnalysisDistributions,
  WalletAnalysisPnl,
  WalletAnalysisSnapshot,
  WalletAnalysisTrades,
  WalletAnalysisWarning,
  WalletExecutionDailyCount,
  WalletExecutionPosition,
  WalletExecutionWarning,
} from "@cogni/poly-node-contracts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { clearTtlCacheByPrefix, coalesce } from "./coalesce";
import { liveCurrentPositions } from "./current-position-staleness";
import {
  EPOCH_ISO,
  withResearchReadTimeout,
  windowedFillCountsSelect,
  windowedFillFlowsSelect,
} from "./fill-rollup-service";
import {
  pickStoredPriceHistoryFidelity,
  readPriceHistoryFromDb,
} from "./price-history-service";
import { getTradingWalletPnlHistoryRead } from "./trading-wallet-overview-service";

/** Cache TTL for every slice. Matches design doc 30 s. */
const SLICE_TTL_MS = 30_000;

/** Trades fetched per analysis request (`computeWalletMetrics` accepts up to ~500 per the Data API cap). */
const TRADE_FETCH_LIMIT = 500;
/** Window for `dailyCounts` in `getSnapshotSlice` (calendar days). */
const SNAPSHOT_DAILY_WINDOW = 14;
/** Top-markets count returned by `getSnapshotSlice`. */
const SNAPSHOT_TOP_MARKETS = 4;
/**
 * Overfetch buffer for the title-fetch query: we look up titles for
 * `SNAPSHOT_TOP_MARKETS + this` candidate cids in `poly_market_metadata` so
 * the displayed list still reaches `SNAPSHOT_TOP_MARKETS` even if a few
 * candidate cids haven't been projected yet (cold-start window between
 * trader-observation tick writing fills and `refreshMarketMetadata` running).
 */
const SNAPSHOT_TOP_MARKETS_OVERFETCH = 8;
/**
 * Min resolved positions before win-rate / PnL fields surface as non-null on
 * the snapshot. Mirrors `computeWalletMetrics`'s `minResolvedForMetrics`
 * default so the SQL-aggregated path stays output-equivalent.
 */
const SNAPSHOT_MIN_RESOLVED = 5;
/**
 * Distributions slice still loads raw fills into JS to feed `summariseOrderFlow`
 * (per-fill histograms + per-group quantiles). Until that helper is rewritten
 * against SQL `width_bucket` + `PERCENTILE_DISC` (CP9 in
 * docs/research/poly/backfill-spike-2026-05-05.md), bound the read at
 * 25K most-recent fills to keep the JS heap below ~50 MB. This is a TEMPORARY
 * safety cap on a single slice; `getSnapshotSlice` proves the SQL-aggregated
 * pattern and is unbounded.
 */
const DISTRIBUTIONS_FILLS_LIMIT_TODO_CP9 = 25_000;
/** Max open/redeemable rows returned in live_positions. */
const EXECUTION_OPEN_LIMIT = 18;
/** Max closed rows returned in closed_positions. */
const EXECUTION_HISTORY_LIMIT = 30;
const EXECUTION_HISTORY_WINDOW_DAYS = 14;
type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

type HistoricalFillRow = {
  conditionId: string;
  tokenId: string;
  side: string;
  price: string | number;
  shares: string | number;
  observedAt: Date;
  raw: Record<string, unknown> | null;
};

/**
 * Module-singleton CLOB public client — retained as a no-op test surface
 * after CP7 swapped the price-history call to a DB read. The CLOB client
 * is no longer invoked at runtime; the singleton persists so existing tests
 * that construct + inject a fake (`__setClientsForTests({ clobPublic })`)
 * continue to compile without rework. Drop both this var and the setter
 * once those tests are migrated.
 */
let clobPublicClient: PolymarketClobPublicClient | undefined;

/** Test-only: kept as a structural shim post-CP7. See note above. */
export function __setClientsForTests(opts: {
  clobPublic?: PolymarketClobPublicClient;
}): void {
  clobPublicClient = opts.clobPublic ?? clobPublicClient;
}

export type SliceResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "warn"; warning: WalletAnalysisWarning };

type SavedFactsSource = "data-api-trades" | "data-api-positions";

export type SavedFactsAvailability =
  | { kind: "ready"; walletId: string; lastSuccessAt: Date }
  | { kind: "wallet_missing" }
  | {
      kind: "source_not_ready";
      source: SavedFactsSource;
      cursorStatus: string | null;
      lastSuccessAt: Date | null;
      reason: "status" | "missing_timestamp" | "expired";
    };

/** Same bounded freshness budget used by the tenant current-position model. */
export const SAVED_FACTS_FRESHNESS_MS = 10 * 60_000;

export interface SavedFactsAvailabilityRow {
  walletId: string;
  cursorStatus: string | null;
  lastSuccessAt: Date | null;
}

/** Pure classification seam used by the bounded DB reader below. */
export function classifySavedFactsAvailability(
  row: SavedFactsAvailabilityRow | undefined,
  source: SavedFactsSource,
  now = new Date()
): SavedFactsAvailability {
  if (!row) return { kind: "wallet_missing" };
  if (row.cursorStatus !== "ok" || row.lastSuccessAt === null) {
    return {
      kind: "source_not_ready",
      source,
      cursorStatus: row.cursorStatus,
      lastSuccessAt: row.lastSuccessAt,
      reason: row.lastSuccessAt === null ? "missing_timestamp" : "status",
    };
  }
  if (now.getTime() - row.lastSuccessAt.getTime() > SAVED_FACTS_FRESHNESS_MS) {
    return {
      kind: "source_not_ready",
      source,
      cursorStatus: row.cursorStatus,
      lastSuccessAt: row.lastSuccessAt,
      reason: "expired",
    };
  }
  return {
    kind: "ready",
    walletId: row.walletId,
    lastSuccessAt: row.lastSuccessAt,
  };
}

/**
 * Constant-cardinality proof that an empty saved-facts slice is a real observed
 * empty result, not an address that has never been ingested.
 *
 * A wallet row proves enrollment. A successful source cursor proves that the
 * relevant upstream collection completed at least once. Only `status=ok`
 * authorizes numeric zero / empty arrays; partial, stale, errored, and never-run
 * sources remain explicitly unavailable.
 */
export async function readSavedFactsAvailability(
  db: Db,
  addr: string,
  source: SavedFactsSource
): Promise<SavedFactsAvailability> {
  const rows = await db
    .select({
      walletId: polyTraderWallets.id,
      cursorStatus: polyTraderIngestionCursors.status,
      lastSuccessAt: polyTraderIngestionCursors.lastSuccessAt,
    })
    .from(polyTraderWallets)
    .leftJoin(
      polyTraderIngestionCursors,
      and(
        eq(polyTraderIngestionCursors.traderWalletId, polyTraderWallets.id),
        eq(polyTraderIngestionCursors.source, source)
      )
    )
    .where(
      and(
        eq(polyTraderWallets.walletAddress, addr.toLowerCase()),
        eq(polyTraderWallets.activeForResearch, true),
        isNull(polyTraderWallets.disabledAt)
      )
    )
    .limit(1);
  return classifySavedFactsAvailability(rows[0], source);
}

function savedFactsWarning(
  slice: WalletAnalysisWarning["slice"],
  availability: Exclude<SavedFactsAvailability, { kind: "ready" }>
): SliceResult<never> {
  const issue = savedFactsIssue(availability);
  return { kind: "warn", warning: { slice, ...issue } };
}

function savedFactsIssue(
  availability: Exclude<SavedFactsAvailability, { kind: "ready" }>
): WalletExecutionWarning {
  if (availability.kind === "wallet_missing") {
    return {
      code: "wallet_not_observed",
      message:
        "This wallet is not enrolled in the active saved-facts observer; empty data would not be authoritative.",
    };
  }
  return {
    code: "saved_facts_not_ready",
    message:
      availability.reason === "expired"
        ? `${availability.source} saved facts are older than the 10-minute freshness window (last success ${availability.lastSuccessAt?.toISOString() ?? "unknown"}).`
        : `${availability.source} has not completed successfully for this wallet (status=${availability.cursorStatus ?? "missing"}).`,
  };
}

/**
 * Evict wallet-scoped slices after a close/redeem write so the next dashboard
 * refetch does not reuse stale process cache entries.
 */
export function invalidateWalletAnalysisCaches(addr: string): void {
  const addressVariants = new Set([addr, addr.toLowerCase()]);
  for (const address of addressVariants) {
    clearTtlCacheByPrefix(`positions:${address}`);
    clearTtlCacheByPrefix(`db-positions:${address}`);
    clearTtlCacheByPrefix(`db-balance:${address}`);
    clearTtlCacheByPrefix(`db-execution-trades:${address}`);
    clearTtlCacheByPrefix(`trades:${address}`);
    clearTtlCacheByPrefix(`execution-trades:${address}`);
    clearTtlCacheByPrefix(`pnl:${address}:`);
    // Interim SWR research caches (research-read-cache.ts) — a close/redeem
    // write must not leave a 60min-stale snapshot/benchmark for this wallet.
    clearTtlCacheByPrefix(`research:snapshot:${address}`);
    clearTtlCacheByPrefix(`research:benchmark:${address}:`);
  }
}

/**
 * DB-backed trades slice — reads `poly_trader_fills` (populated by the
 * trader-observation tick). PAGE_LOAD_DB_ONLY (task.5012 CP2).
 *
 * Market title is recovered from the per-row `raw` jsonb that the writer
 * preserves at ingest. When `raw.attributes.title` is absent or empty the
 * recent-trade row falls back to `null` (chart already handles this).
 */
export async function getTradesSlice(
  db: Db,
  addr: string
): Promise<SliceResult<WalletAnalysisTrades>> {
  try {
    const boundedRead = await withResearchReadTimeout(db, async (tx) => {
      const availability = await readSavedFactsAvailability(
        tx,
        addr,
        "data-api-trades"
      );
      return {
        availability,
        rows:
          availability.kind === "ready"
            ? await readRecentTradesFromDb(tx, availability.walletId)
            : [],
      };
    });
    const { availability, rows } = boundedRead;
    if (availability.kind !== "ready") {
      return savedFactsWarning("trades", availability);
    }

    const trades = rows.map((row) => ({
      timestamp: Math.floor(row.observedAt.getTime() / 1_000),
      side: row.side as "BUY" | "SELL",
      conditionId: row.conditionId,
      asset: row.tokenId,
      size: Number(row.shares),
      price: Number(row.price),
      title: extractTitle(row.raw),
    }));

    const dailyCounts = buildDailyCounts(trades, 14);
    const topMarkets = buildTopMarkets(trades, 4);
    const recent = trades.slice(0, 50).map((t) => ({
      timestampSec: t.timestamp,
      side: t.side,
      conditionId: t.conditionId,
      asset: t.asset,
      size: t.size,
      price: t.price,
      marketTitle: t.title || null,
    }));
    return {
      kind: "ok",
      value: {
        recent,
        dailyCounts,
        topMarkets,
        computedAt: availability.lastSuccessAt.toISOString(),
      },
    };
  } catch (err) {
    return {
      kind: "warn",
      warning: warning("trades", err),
    };
  }
}

/**
 * Recent fills seek directly by the observer UUID returned by the availability
 * read. Keeping the address join out of this LIMIT query gives Postgres the
 * exact `(trader_wallet_id, observed_at)` index predicate even for sparse
 * wallets whose total fill count never reaches the limit.
 *
 * @internal
 */
async function readRecentTradesFromDb(
  db: Db,
  traderWalletId: string
): Promise<HistoricalFillRow[]> {
  const result = (await db.execute(sql`
    SELECT
      f.condition_id AS "conditionId",
      f.token_id AS "tokenId",
      f.side,
      f.price,
      f.shares,
      f.observed_at AS "observedAt",
      f.raw
    FROM ${polyTraderFills} f
    WHERE f.trader_wallet_id = ${traderWalletId}::uuid
    ORDER BY f.observed_at DESC
    LIMIT ${TRADE_FETCH_LIMIT}
  `)) as unknown as { rows?: Array<Record<string, unknown>> };
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return rows as HistoricalFillRow[];
}

function extractTitle(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const attrs = (raw as { attributes?: Record<string, unknown> }).attributes;
  if (!attrs) return "";
  const title = attrs.title;
  return typeof title === "string" ? title : "";
}

/**
 * Compute the snapshot (deterministic metrics) slice. PAGE_LOAD_DB_ONLY
 * (task.5012 CP4): activity metrics come from `poly_trader_fills`, resolutions
 * from `poly_market_outcomes`, and the current open book from
 * `poly_trader_current_positions`. The latter is authoritative for holdings
 * opened before this observer's forward-only fill history began.
 */
export async function getSnapshotSlice(
  db: Db,
  addr: string
): Promise<SliceResult<WalletAnalysisSnapshot>> {
  try {
    const tradeAvailability = await readSavedFactsAvailability(
      db,
      addr,
      "data-api-trades"
    );
    if (tradeAvailability.kind !== "ready") {
      return savedFactsWarning("snapshot", tradeAvailability);
    }
    const positionAvailability = await readSavedFactsAvailability(
      db,
      addr,
      "data-api-positions"
    );
    if (positionAvailability.kind !== "ready") {
      return savedFactsWarning("snapshot", positionAvailability);
    }
    const lower = addr.toLowerCase();
    // Four small SQL aggregations — none of them load raw fills/positions.
    // (1) Per-(condition_id, token_id) aggregates ≈ unique-market count.
    // (2) Daily counts for the SNAPSHOT_DAILY_WINDOW (14 rows).
    // (3) 30-day count + latest timestamp + total fill count (1 row).
    // (4) Current open-position count + cost basis (1 row). This is the
    //     authoritative current book; fill history can be intentionally
    //     forward-only and therefore cannot prove current holdings.
    // These can all touch the not-yet-rolled tail. Keep them on one bounded
    // connection instead of fanning four scans across the pool at once.
    const { positions, dailyRows, activity, currentBook } =
      await withResearchReadTimeout(db, async (tx) => {
        const positions = await readPositionAggregatesFromDb(tx, lower);
        const dailyRows = await readDailyCountsFromDb(
          tx,
          lower,
          SNAPSHOT_DAILY_WINDOW
        );
        const activity = await readActivityCountsFromDb(tx, lower);
        const currentBook = await readCurrentBookSummaryFromDb(tx, lower);
        return { positions, dailyRows, activity, currentBook };
      });
    const cids = [...new Set(positions.map((p) => p.conditionId))];
    // Pick the most-recent candidate condition_ids for `topMarkets`; overfetch
    // a small buffer so the displayed list still reaches `topLimit` even when
    // a few candidates haven't been projected into poly_market_metadata yet.
    const topCidCandidates = pickTopMarketCandidateCids(
      positions,
      SNAPSHOT_TOP_MARKETS + SNAPSHOT_TOP_MARKETS_OVERFETCH
    );
    const [resolutions, titles] = await Promise.all([
      readResolutionsForConditions(db, cids),
      readMarketTitlesForConditions(db, topCidCandidates),
    ]);

    const m = composeSnapshotFromAggregates({
      positions,
      titles,
      dailyRows,
      activity,
      resolutions,
      window: SNAPSHOT_DAILY_WINDOW,
      topLimit: SNAPSHOT_TOP_MARKETS,
      minResolved: SNAPSHOT_MIN_RESOLVED,
    });
    return {
      kind: "ok",
      value: {
        resolvedPositions: m.resolvedPositions,
        wins: m.wins,
        losses: m.losses,
        trueWinRatePct: m.trueWinRatePct,
        medianDurationHours: m.medianDurationHours,
        openPositions: currentBook.openPositions,
        openNetCostUsdc: currentBook.openNetCostUsdc,
        uniqueMarkets: m.uniqueMarkets,
        tradesPerDay30d: m.tradesPerDay30d,
        daysSinceLastTrade: Number.isFinite(m.daysSinceLastTrade)
          ? m.daysSinceLastTrade
          : 0,
        topMarkets: [...m.topMarkets],
        dailyCounts: m.dailyCounts.map((d) => ({ day: d.day, n: d.n })),
        computedAt: new Date(
          Math.min(
            tradeAvailability.lastSuccessAt.getTime(),
            positionAvailability.lastSuccessAt.getTime()
          )
        ).toISOString(),
        // task.0333 swaps this for a Dolt read; null is a fine v0 default.
        hypothesisMd: null,
      },
    };
  } catch (err) {
    return {
      kind: "warn",
      warning: warning("snapshot", err),
    };
  }
}

/**
 * Constant-cardinality current-book aggregate for snapshot headline fields.
 * The forward-only fill corpus is valid for activity metrics, but it cannot
 * reconstruct positions opened before enrollment. The current-position mirror
 * is the saved Data-API fact that can.
 */
async function readCurrentBookSummaryFromDb(
  db: Db,
  walletAddrLower: string
): Promise<{ openPositions: number; openNetCostUsdc: number }> {
  const rows = await db
    .select({
      openPositions: sql<number>`count(*)::int`,
      openNetCostUsdc: sql<number>`
        coalesce(sum(${polyTraderCurrentPositions.costBasisUsdc}), 0)::float8
      `,
    })
    .from(polyTraderCurrentPositions)
    .innerJoin(
      polyTraderWallets,
      eq(polyTraderWallets.id, polyTraderCurrentPositions.traderWalletId)
    )
    .where(
      and(
        eq(polyTraderWallets.walletAddress, walletAddrLower),
        liveCurrentPositions()
      )
    );
  return {
    openPositions: Number(rows[0]?.openPositions ?? 0),
    openNetCostUsdc: Math.round(Number(rows[0]?.openNetCostUsdc ?? 0)),
  };
}

/**
 * Distributions slice — order-flow histograms (DCA depth, trade size, entry
 * price, DCA window, hour-of-day, event clustering) with won/lost/pending
 * outcome split. PAGE_LOAD_DB_ONLY (task.5012 CP4): trades from
 * `poly_trader_fills`, resolutions from `poly_market_outcomes`. The legacy
 * `live` mode is collapsed into `historical` — both modes now read DB only;
 * `mode` is preserved on the response for contract continuity.
 */
export async function getDistributionsSlice(
  db: Db,
  addr: string,
  mode: "live" | "historical"
): Promise<SliceResult<WalletAnalysisDistributions>> {
  try {
    const availability = await readSavedFactsAvailability(
      db,
      addr,
      "data-api-trades"
    );
    if (availability.kind !== "ready") {
      return savedFactsWarning("distributions", availability);
    }
    const trades = await coalesce(
      `historical-trader-fills:${addr}`,
      async () => {
        const fills = await readWalletFillsTodoCp9(db, addr);
        return fills.map(historicalFillToOrderFlowTrade);
      },
      SLICE_TTL_MS
    );
    const cids = [...new Set(trades.map((t) => t.conditionId))];
    const resolutions = await readResolutionsForConditions(db, cids);

    const summary = summariseOrderFlow(trades, resolutions);
    return {
      kind: "ok",
      value: {
        mode,
        range: summary.range,
        dcaDepth: { buckets: [...summary.dcaDepth.buckets] },
        tradeSize: { buckets: [...summary.tradeSize.buckets] },
        entryPrice: { buckets: [...summary.entryPrice.buckets] },
        dcaWindow: { buckets: [...summary.dcaWindow.buckets] },
        hourOfDay: { buckets: [...summary.hourOfDay.buckets] },
        eventClustering: { buckets: [...summary.eventClustering.buckets] },
        topEvents: [...summary.topEvents],
        pendingShare: summary.pendingShare,
        quantiles: summary.quantiles,
        computedAt: availability.lastSuccessAt.toISOString(),
      },
    };
  } catch (err) {
    return {
      kind: "warn",
      warning: warning("distributions", err),
    };
  }
}

/**
 * Per-(condition_id, token_id) pre-aggregate of one wallet's fills. Output row
 * count is bounded by `COUNT(DISTINCT (condition_id, token_id))` for the
 * wallet — i.e. unique markets traded, NOT total fills. This is what makes the
 * snapshot path scale to wallets with millions of fills: SQL collapses the
 * fill stream to a few thousand position rows before we ever touch JS heap.
 *
 * Numeric-only by design — the per-position market title is sourced from
 * `poly_market_metadata` (the canonical per-conditionId metadata store, task
 * 1265), not from this fill-stream aggregate. Pulling
 * `MAX(raw->'attributes'->>'title')` here forced a full TOAST-decompressed
 * jsonb scan over every fill (~500 MB / 33 s on RN1's 836 K rows) just to
 * surface 4 strings — see `readMarketTitlesForConditions`.
 *
 * Exported for the parity test that asserts `composeSnapshotFromAggregates`
 * stays output-equivalent to `computeWalletMetrics` for the snapshot fields.
 *
 * @internal
 */
export type PositionAggregate = {
  conditionId: string;
  tokenId: string;
  buyUsdc: number;
  sellUsdc: number;
  buyShares: number;
  sellShares: number;
  /** Earliest observed_at of any BUY fill on this token. -1 when none. */
  firstBuyTs: number;
  /** Latest observed_at on this token (any side). */
  lastTs: number;
};

/**
 * Rollup-backed since task.research-rollup-read-models: aggregates
 * `poly_trader_fill_rollups_daily` day-rows (plus the not-yet-rolled fill
 * tail — READERS_ADD_THE_TAIL in fill-rollup-service.ts) instead of scanning
 * the wallet's full fill history (26.5-57s on prod RN1, 2026-09-28). Output
 * is exactly equivalent to the legacy full-scan GROUP BY, proven by the
 * component parity suite against the preserved oracle
 * (`@tests/_fixtures/poly/research-live-scan-oracles`).
 *
 * @internal — exported for the rollup parity tests only.
 */
export async function readPositionAggregatesFromDb(
  db: Db,
  walletAddrLower: string
): Promise<PositionAggregate[]> {
  const walletRows = await db
    .select({ id: polyTraderWallets.id })
    .from(polyTraderWallets)
    .where(eq(polyTraderWallets.walletAddress, walletAddrLower))
    .limit(1);
  const walletId = walletRows[0]?.id;
  if (!walletId) return [];
  const flows = windowedFillFlowsSelect({
    walletIds: [walletId],
    windowStartIso: EPOCH_ISO,
  });
  const rows = (await db.execute(sql`
    SELECT
      fl.condition_id AS "conditionId",
      fl.token_id AS "tokenId",
      fl.buy_usdc::float8 AS "buyUsdc",
      fl.sell_usdc::float8 AS "sellUsdc",
      fl.buy_shares::float8 AS "buyShares",
      fl.sell_shares::float8 AS "sellShares",
      COALESCE(EXTRACT(EPOCH FROM fl.first_buy_observed_at), -1)::float8 AS "firstBuyTs",
      EXTRACT(EPOCH FROM fl.last_observed_at)::float8 AS "lastTs"
    FROM (${flows}) fl
  `)) as unknown as {
    rows?: Array<Record<string, unknown>>;
  };
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return (list as Array<Record<string, unknown>>).map((r) => ({
    conditionId: String(r.conditionId ?? ""),
    tokenId: String(r.tokenId ?? ""),
    buyUsdc: Number(r.buyUsdc ?? 0),
    sellUsdc: Number(r.sellUsdc ?? 0),
    buyShares: Number(r.buyShares ?? 0),
    sellShares: Number(r.sellShares ?? 0),
    firstBuyTs: Number(r.firstBuyTs ?? -1),
    lastTs: Number(r.lastTs ?? 0),
  }));
}

/**
 * Resolve display titles for the given conditionIds from `poly_market_metadata`
 * — the canonical per-conditionId metadata store written by `refreshMarketMetadata`
 * (task 1265). One row per conditionId (PK), independent of wallet, so the IN-list
 * reads exactly `conditionIds.length` rows.
 *
 * Prefers `event_title` (parent event, e.g. "ATP Madrid R32") over `market_title`
 * (the specific bet, e.g. "Shevche vs Added") because event titles are more
 * readable for the snapshot's `topMarkets` headline; falls back to market_title
 * when the row is missing event_title (the bug.5018 condition until that ships).
 */
async function readMarketTitlesForConditions(
  db: Db,
  conditionIds: ReadonlyArray<string>
): Promise<Map<string, string>> {
  if (conditionIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT
      condition_id AS "conditionId",
      COALESCE(NULLIF(event_title, ''), NULLIF(market_title, '')) AS "title"
    FROM ${polyMarketMetadata}
    WHERE condition_id IN (${sql.join(
      conditionIds.map((c) => sql`${c}`),
      sql`, `
    )})
  `)) as unknown as { rows?: Array<Record<string, unknown>> };
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const out = new Map<string, string>();
  for (const r of list as Array<Record<string, unknown>>) {
    const cid = String(r.conditionId ?? "");
    const title = typeof r.title === "string" ? r.title : "";
    if (cid && title) out.set(cid, title);
  }
  return out;
}

/**
 * Daily fill count for the most recent N calendar days (UTC). Returns at most
 * N rows; days with zero fills are absent and the composer fills them in.
 */
async function readDailyCountsFromDb(
  db: Db,
  walletAddrLower: string,
  windowDays: number
): Promise<Array<{ day: string; n: number }>> {
  const rows = (await db.execute(sql`
    SELECT
      to_char(date_trunc('day', f.observed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
      COUNT(*)::int AS n
    FROM ${polyTraderFills} f
    INNER JOIN ${polyTraderWallets} w ON w.id = f.trader_wallet_id
    WHERE w.wallet_address = ${walletAddrLower}
      AND f.observed_at >= now() - (${windowDays} || ' days')::interval
    GROUP BY 1
    ORDER BY 1
  `)) as unknown as { rows?: Array<Record<string, unknown>> };
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return (list as Array<Record<string, unknown>>).map((r) => ({
    day: String(r.day ?? ""),
    n: Number(r.n ?? 0),
  }));
}

/**
 * Single-row activity summary: rolling 30-day count + latest fill timestamp.
 * Drives `tradesPerDay30d` and `daysSinceLastTrade` without scanning fills in JS.
 *
 * Rollup-backed since task.research-rollup-read-models: the legacy shape
 * FILTERed the 30-day count with no WHERE bound, so Postgres walked the
 * wallet's ENTIRE fill history per request. The 30-day count now sums rollup
 * day-rows (+ boundary/tail fills); `latestTs` is a bounded index MAX on
 * `(trader_wallet_id, observed_at)`. The window start moves from SQL `now()`
 * to JS `Date.now()` — a sub-millisecond boundary shift with no consumer
 * (`tradesPerDay30d` is rounded to 2dp).
 */
async function readActivityCountsFromDb(
  db: Db,
  walletAddrLower: string
): Promise<{ recent30: number; latestTs: number }> {
  const walletRows = await db
    .select({ id: polyTraderWallets.id })
    .from(polyTraderWallets)
    .where(eq(polyTraderWallets.walletAddress, walletAddrLower))
    .limit(1);
  const walletId = walletRows[0]?.id;
  if (!walletId) return { recent30: 0, latestTs: 0 };
  const windowStartIso = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();
  const counts = windowedFillCountsSelect({
    walletIds: [walletId],
    windowStartIso,
  });
  const rows = (await db.execute(sql`
    SELECT
      COALESCE((SELECT wc.trade_count FROM (${counts}) wc), 0)::int AS "recent30",
      COALESCE(
        EXTRACT(EPOCH FROM (
          SELECT MAX(f.observed_at)
          FROM ${polyTraderFills} f
          WHERE f.trader_wallet_id = ${walletId}::uuid
        )),
        0
      )::float8 AS "latestTs"
  `)) as unknown as { rows?: Array<Record<string, unknown>> };
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const r = (list[0] as Record<string, unknown> | undefined) ?? {};
  return {
    recent30: Number(r.recent30 ?? 0),
    latestTs: Number(r.latestTs ?? 0),
  };
}

/**
 * Most-recent condition_ids dedup'd by conditionId, capped at `limit`. Used
 * to scope the per-cid title fetch so the snapshot doesn't pull titles for
 * every market a wallet has ever touched.
 *
 * @internal
 */
export function pickTopMarketCandidateCids(
  positions: ReadonlyArray<PositionAggregate>,
  limit: number
): string[] {
  const byRecent = [...positions].sort((a, b) => b.lastTs - a.lastTs);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of byRecent) {
    if (seen.has(p.conditionId)) continue;
    seen.add(p.conditionId);
    out.push(p.conditionId);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Compose the snapshot from SQL pre-aggregates. Mirrors the per-position
 * resolution math in `computeWalletMetrics` (lines 147–254 of wallet-metrics.ts)
 * but operates on already-aggregated rows so it's `O(uniqueMarkets)` instead
 * of `O(fills)`. Output is bit-equivalent to `computeWalletMetrics(trades, ...)`
 * for the fields snapshot surfaces; PnL fields are intentionally omitted per
 * `PNL_NOT_IN_SNAPSHOT`.
 *
 * @internal — exported for parity testing only.
 */
export function composeSnapshotFromAggregates(input: {
  positions: ReadonlyArray<PositionAggregate>;
  titles: ReadonlyMap<string, string>;
  dailyRows: ReadonlyArray<{ day: string; n: number }>;
  activity: { recent30: number; latestTs: number };
  resolutions: ReadonlyMap<string, MarketResolutionInput>;
  window: number;
  topLimit: number;
  minResolved: number;
}): {
  resolvedPositions: number;
  wins: number;
  losses: number;
  trueWinRatePct: number | null;
  medianDurationHours: number | null;
  openPositions: number;
  openNetCostUsdc: number;
  uniqueMarkets: number;
  tradesPerDay30d: number;
  daysSinceLastTrade: number;
  topMarkets: ReadonlyArray<string>;
  dailyCounts: ReadonlyArray<{ day: string; n: number }>;
} {
  type Resolved = { pnl: number; won: boolean; durationSec: number };
  const resolved: Resolved[] = [];
  let openCount = 0;
  let openNetCost = 0;

  for (const p of input.positions) {
    const m = input.resolutions.get(p.conditionId);
    const tokenInfo = m?.tokens.find((x) => x.token_id === p.tokenId);
    if (m?.closed && tokenInfo) {
      const held = p.buyShares - p.sellShares;
      const payout = held > 0 && tokenInfo.winner ? held : 0;
      const pnl = p.sellUsdc + payout - p.buyUsdc;
      const duration = p.firstBuyTs >= 0 ? p.lastTs - p.firstBuyTs : 0;
      resolved.push({ pnl, won: pnl > 0.5, durationSec: duration });
    } else {
      openNetCost += p.buyUsdc - p.sellUsdc;
      openCount++;
    }
  }

  const wins = resolved.filter((r) => r.won).length;
  const losses = resolved.filter((r) => r.pnl < -0.5).length;
  const enough = resolved.length >= input.minResolved;
  const trueWinRatePct = enough
    ? +((wins / resolved.length) * 100).toFixed(1)
    : null;

  const durations = resolved
    .map((r) => r.durationSec)
    .filter((x) => x > 0)
    .sort((a, b) => a - b);
  const medianDurationHours =
    enough && durations.length > 0
      ? +((durations[Math.floor(durations.length / 2)] ?? 0) / 3_600).toFixed(2)
      : null;

  // topMarkets: most-recently-touched conditionId, dedup'd by conditionId, capped.
  // Titles come from `input.titles` (resolved by `readMarketTitlesForConditions`
  // against `poly_market_metadata`) — keeps this composer pure and the hot
  // aggregate path free of jsonb reads.
  const byRecent = [...input.positions].sort((a, b) => b.lastTs - a.lastTs);
  const topMarkets: string[] = [];
  const seenCond = new Set<string>();
  for (const p of byRecent) {
    if (seenCond.has(p.conditionId)) continue;
    const title = input.titles.get(p.conditionId);
    if (!title) continue;
    seenCond.add(p.conditionId);
    topMarkets.push(title);
    if (topMarkets.length >= input.topLimit) break;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const SEC_PER_DAY = 86_400;
  const tradesPerDay30d = +(input.activity.recent30 / 30).toFixed(2);
  const daysSinceLastTrade = input.activity.latestTs
    ? +((nowSec - input.activity.latestTs) / SEC_PER_DAY).toFixed(2)
    : Number.POSITIVE_INFINITY;

  // dailyCounts: pad missing days with zero, oldest → newest, exact `window` length.
  const byDay = new Map<string, number>();
  for (const r of input.dailyRows) byDay.set(r.day, r.n);
  const dailyCounts: Array<{ day: string; n: number }> = [];
  for (let i = input.window - 1; i >= 0; i--) {
    const ts = nowSec - i * SEC_PER_DAY;
    const day = new Date(ts * 1_000).toISOString().slice(0, 10);
    dailyCounts.push({ day, n: byDay.get(day) ?? 0 });
  }

  return {
    resolvedPositions: resolved.length,
    wins,
    losses,
    trueWinRatePct,
    medianDurationHours,
    openPositions: openCount,
    openNetCostUsdc: Math.round(openNetCost),
    uniqueMarkets: input.positions.length,
    tradesPerDay30d,
    daysSinceLastTrade,
    topMarkets,
    dailyCounts,
  };
}

/**
 * Read `poly_market_outcomes` rows for the given conditionIds and group into
 * the `MarketResolutionInput` shape `computeWalletMetrics` / `summariseOrderFlow`
 * expect. A condition is `closed=true` only when ALL its observed token rows
 * carry a non-`unknown` outcome. Conditions absent from the table do not appear
 * in the returned map — downstream math then treats them as open/unresolved.
 */
async function readResolutionsForConditions(
  db: Db,
  conditionIds: ReadonlyArray<string>
): Promise<Map<string, MarketResolutionInput>> {
  const out = new Map<string, MarketResolutionInput>();
  if (conditionIds.length === 0) return out;

  const rows = (await db
    .select({
      conditionId: polyMarketOutcomes.conditionId,
      tokenId: polyMarketOutcomes.tokenId,
      outcome: polyMarketOutcomes.outcome,
    })
    .from(polyMarketOutcomes)
    .where(
      inArray(polyMarketOutcomes.conditionId, [...conditionIds])
    )) as Array<{
    conditionId: string;
    tokenId: string;
    outcome: string;
  }>;

  const grouped = new Map<
    string,
    Array<{ token_id: string; winner: boolean; resolved: boolean }>
  >();
  for (const row of rows) {
    const list = grouped.get(row.conditionId) ?? [];
    list.push({
      token_id: row.tokenId,
      winner: row.outcome === "winner",
      resolved: row.outcome !== "unknown",
    });
    grouped.set(row.conditionId, list);
  }

  for (const [cid, tokens] of grouped) {
    const closed = tokens.length > 0 && tokens.every((t) => t.resolved);
    out.set(cid, {
      closed,
      tokens: tokens.map((t) => ({ token_id: t.token_id, winner: t.winner })),
    });
  }
  return out;
}

type DbFillRow = HistoricalFillRow;

/**
 * Execution-slice fill read: bounded by the wallet's CURRENT POSITION SET
 * rather than by row count. Pulls only fills whose `condition_id` is in the
 * wallet's `poly_trader_current_positions` (≈ EXECUTION_OPEN_LIMIT +
 * EXECUTION_HISTORY_LIMIT positions, so a few thousand rows max even on whale
 * wallets like RN1). This is the architecturally-correct shape for execution:
 * the slice only renders per-position trade timelines for displayed positions,
 * so fills outside that set are dead weight. Unbounded reads on this path
 * caused the candidate-a OOM (spike.5024 backfill of 825 K RN1 fills).
 */
async function readFillsForActivePositionsFromDb(
  db: Db,
  addr: string
): Promise<DbFillRow[]> {
  const lower = addr.toLowerCase();
  const rows = (await db.execute(sql`
    SELECT
      f.condition_id  AS "conditionId",
      f.token_id      AS "tokenId",
      f.side,
      f.price,
      f.shares,
      f.observed_at   AS "observedAt",
      f.raw
    FROM ${polyTraderFills} f
    INNER JOIN ${polyTraderWallets} w ON w.id = f.trader_wallet_id
    WHERE w.wallet_address = ${lower}
      AND f.condition_id IN (
        SELECT cp.condition_id
        FROM ${polyTraderCurrentPositions} cp
        WHERE cp.trader_wallet_id = w.id
      )
    ORDER BY f.observed_at ASC
  `)) as unknown as { rows?: Array<Record<string, unknown>> };
  const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
  return (list as Array<Record<string, unknown>>).map((r) => ({
    conditionId: String(r.conditionId ?? ""),
    tokenId: String(r.tokenId ?? ""),
    side: String(r.side ?? "BUY") as "BUY" | "SELL",
    price: String(r.price ?? "0"),
    shares: String(r.shares ?? "0"),
    observedAt:
      r.observedAt instanceof Date
        ? r.observedAt
        : new Date(String(r.observedAt)),
    raw: (r.raw ?? null) as Record<string, unknown> | null,
  })) as DbFillRow[];
}

/**
 * TEMPORARY — distributions-slice fill read with a 25 K most-recent cap.
 * Removed when `summariseOrderFlow` is rewritten to consume SQL aggregates
 * (CP9 in docs/research/poly/backfill-spike-2026-05-05.md). Unlike snapshot's
 * SQL-aggregated path, distributions still computes histograms in JS, so the
 * cap is a memory safety net. Documented as `slice_truncated` warnings would
 * blank the slice on the dashboard, so we silently truncate (matches
 * `getTradesSlice`'s 500-row cap).
 */
async function readWalletFillsTodoCp9(
  db: Db,
  addr: string
): Promise<HistoricalFillRow[]> {
  const fetched = (await db
    .select({
      conditionId: polyTraderFills.conditionId,
      tokenId: polyTraderFills.tokenId,
      side: polyTraderFills.side,
      price: polyTraderFills.price,
      shares: polyTraderFills.shares,
      observedAt: polyTraderFills.observedAt,
      raw: polyTraderFills.raw,
    })
    .from(polyTraderFills)
    .innerJoin(
      polyTraderWallets,
      eq(polyTraderWallets.id, polyTraderFills.traderWalletId)
    )
    .where(eq(polyTraderWallets.walletAddress, addr.toLowerCase()))
    .orderBy(desc(polyTraderFills.observedAt))
    .limit(DISTRIBUTIONS_FILLS_LIMIT_TODO_CP9)) as HistoricalFillRow[];
  fetched.reverse(); // ASC for the consumer's mental model
  return fetched;
}

/**
 * Project a `poly_trader_current_positions` row into the
 * `PolymarketUserPosition` shape `mapExecutionPositions` expects. The fields
 * not stored on the DB row (eventId, oppositeAsset, …) are filled with the
 * permissive defaults from `PolymarketUserPositionSchema` so downstream
 * mapping is lossless for the dashboard slice.
 */
function dbPositionToUserPosition(
  row: DbCurrentPositionRow
): PolymarketUserPosition {
  const raw = isRecord(row.raw) ? row.raw : {};
  const shares = toFiniteNumber(row.shares);
  const costBasis = toFiniteNumber(row.costBasisUsdc);
  const currentValue = toFiniteNumber(row.currentValueUsdc);
  const avgPrice = toFiniteNumber(row.avgPrice);
  const rawCurPrice = readOptionalNumber(raw, "curPrice");
  const curPrice = rawCurPrice ?? (shares > 0 ? currentValue / shares : 0);
  const cashPnl = currentValue - costBasis;
  const percentPnl = costBasis > 0 ? (cashPnl / costBasis) * 100 : 0;
  const redeemable = readOptionalBoolean(raw, "redeemable") ?? false;
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  return {
    proxyWallet: readOptionalString(raw, "proxyWallet") ?? "",
    asset: row.tokenId,
    conditionId: row.conditionId,
    size: shares,
    avgPrice,
    initialValue: costBasis,
    currentValue,
    cashPnl,
    percentPnl,
    totalBought: readOptionalNumber(raw, "totalBought") ?? 0,
    realizedPnl: readOptionalNumber(raw, "realizedPnl") ?? 0,
    percentRealizedPnl: readOptionalNumber(raw, "percentRealizedPnl") ?? 0,
    curPrice,
    redeemable,
    mergeable: readOptionalBoolean(raw, "mergeable") ?? false,
    title:
      readOptionalString(raw, "title") ??
      readOptionalString(attributes, "title") ??
      "",
    slug:
      readOptionalString(raw, "slug") ??
      readOptionalString(attributes, "slug") ??
      "",
    icon: readOptionalString(raw, "icon") ?? "",
    eventId: readOptionalString(raw, "eventId") ?? "",
    eventSlug:
      readOptionalString(raw, "eventSlug") ??
      readOptionalString(attributes, "event_slug") ??
      "",
    outcome: readOptionalString(raw, "outcome") ?? "",
    outcomeIndex: readOptionalNumber(raw, "outcomeIndex") ?? 0,
    oppositeOutcome: readOptionalString(raw, "oppositeOutcome") ?? "",
    oppositeAsset: readOptionalString(raw, "oppositeAsset") ?? "",
    endDate: readOptionalString(raw, "endDate") ?? "",
    negativeRisk: readOptionalBoolean(raw, "negativeRisk") ?? false,
  };
}

/**
 * Project a `poly_trader_fills` row into the `PolymarketUserTrade` shape
 * `mapExecutionPositions` expects. Mirrors the historical-distributions
 * projection (`historicalFillToOrderFlowTrade`) but emits the trade-shape
 * fields the position-timeline mapper needs.
 */
function dbFillToUserTrade(row: DbFillRow): PolymarketUserTrade {
  const raw = isRecord(row.raw) ? row.raw : {};
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const side = row.side === "SELL" ? "SELL" : "BUY";
  return {
    proxyWallet: readOptionalString(raw, "proxyWallet") ?? "",
    side,
    asset: row.tokenId,
    conditionId: row.conditionId,
    size: toFiniteNumber(row.shares),
    price: toFiniteNumber(row.price),
    timestamp: Math.floor(row.observedAt.getTime() / 1000),
    title:
      readOptionalString(raw, "title") ??
      readOptionalString(attributes, "title") ??
      "",
    slug:
      readOptionalString(raw, "slug") ??
      readOptionalString(attributes, "slug") ??
      "",
    eventSlug:
      readOptionalString(raw, "eventSlug") ??
      readOptionalString(attributes, "event_slug") ??
      "",
    icon: readOptionalString(raw, "icon") ?? "",
    outcome: readOptionalString(raw, "outcome") ?? "",
    outcomeIndex: readOptionalNumber(raw, "outcomeIndex") ?? 0,
    transactionHash:
      readOptionalString(raw, "transactionHash") ??
      readOptionalString(raw, "txHash") ??
      "",
  };
}

function historicalFillToOrderFlowTrade(
  row: HistoricalFillRow
): OrderFlowTrade {
  const raw = isRecord(row.raw) ? row.raw : {};
  const attributes = isRecord(raw.attributes) ? raw.attributes : {};
  const shares = toFiniteNumber(row.shares);
  const price = toFiniteNumber(row.price);
  return {
    side: row.side,
    asset: row.tokenId,
    conditionId: row.conditionId,
    size: shares,
    price,
    timestamp: Math.floor(row.observedAt.getTime() / 1000),
    ...optionalField("title", readOptionalString(attributes, "title")),
    ...optionalField("outcome", readOptionalString(raw, "outcome")),
    ...optionalField("slug", readOptionalString(attributes, "slug")),
    ...optionalField("eventSlug", readOptionalString(attributes, "event_slug")),
  };
}

/**
 * Balance slice — positions for any wallet, sourced from the DB-backed
 * `poly_trader_current_positions` mirror written by the trader-observation
 * tick (task.5005). PAGE_LOAD_DB_ONLY (task.5012 CP5) — no outbound HTTP.
 *
 * Post-Stage-4 (OPERATOR_BRANCH_DORMANT): the single-operator "available +
 * locked" breakdown that used to run for `addr === POLY_PROTO_WALLET_ADDRESS`
 * has been purged. `isOperator` stays in the contract shape as `false` so
 * callers that still branch on it compile — a per-tenant replacement lives
 * with the Money page rework and will go through `PolyTradeExecutor`, not
 * this helper.
 */
export async function getBalanceSlice(
  db: Db,
  addr: string
): Promise<SliceResult<WalletAnalysisBalance>> {
  try {
    const availability = await readSavedFactsAvailability(
      db,
      addr,
      "data-api-positions"
    );
    if (availability.kind !== "ready") {
      return savedFactsWarning("balance", availability);
    }
    const rows = await coalesce(
      `db-balance:${addr}`,
      () => readCurrentPositionsFromDb(db, addr),
      SLICE_TTL_MS
    );
    const positionsValue = rows.reduce(
      (sum, row) => sum + toFiniteNumber(row.currentValueUsdc),
      0
    );

    return {
      kind: "ok",
      value: {
        positions: positionsValue,
        total: positionsValue,
        isOperator: false,
        computedAt: availability.lastSuccessAt.toISOString(),
      },
    };
  } catch (err) {
    return {
      kind: "warn",
      warning: warning("balance", err),
    };
  }
}

type DbCurrentPositionRow = {
  conditionId: string;
  tokenId: string;
  shares: string | number;
  costBasisUsdc: string | number;
  currentValueUsdc: string | number;
  avgPrice: string | number;
  lastObservedAt: Date;
  firstObservedAt: Date;
  raw: Record<string, unknown> | null;
};

async function readCurrentPositionsFromDb(
  db: Db,
  addr: string
): Promise<DbCurrentPositionRow[]> {
  const rows = await db
    .select({
      conditionId: polyTraderCurrentPositions.conditionId,
      tokenId: polyTraderCurrentPositions.tokenId,
      shares: polyTraderCurrentPositions.shares,
      costBasisUsdc: polyTraderCurrentPositions.costBasisUsdc,
      currentValueUsdc: polyTraderCurrentPositions.currentValueUsdc,
      avgPrice: polyTraderCurrentPositions.avgPrice,
      lastObservedAt: polyTraderCurrentPositions.lastObservedAt,
      firstObservedAt: polyTraderCurrentPositions.firstObservedAt,
      raw: polyTraderCurrentPositions.raw,
    })
    .from(polyTraderCurrentPositions)
    .innerJoin(
      polyTraderWallets,
      eq(polyTraderWallets.id, polyTraderCurrentPositions.traderWalletId)
    )
    .where(
      and(
        eq(polyTraderWallets.walletAddress, addr.toLowerCase()),
        liveCurrentPositions()
      )
    );
  return rows as DbCurrentPositionRow[];
}

/**
 * Profit/loss slice — DB-backed Polymarket user P/L history. Reads from
 * `poly_trader_user_pnl_points`; the trader-observation tick is the only
 * caller that hits the live `/user-pnl` API. PAGE_LOAD_DB_ONLY (task.5012).
 */
export async function getPnlSlice(
  db: Db,
  addr: string,
  interval: PolyWalletOverviewInterval
): Promise<SliceResult<WalletAnalysisPnl>> {
  const requestedAt = new Date().toISOString();
  try {
    const pnlRead = await getTradingWalletPnlHistoryRead({
      db,
      address: addr as `0x${string}`,
      interval,
      capturedAt: requestedAt,
    });
    if (pnlRead.status === "wallet_missing") {
      return savedFactsWarning("pnl", { kind: "wallet_missing" });
    }
    if (pnlRead.status === "no_history" || pnlRead.status === "stale") {
      return {
        kind: "warn",
        warning: {
          slice: "pnl",
          code:
            pnlRead.status === "stale"
              ? "pnl_history_stale"
              : "pnl_history_not_recorded",
          message:
            pnlRead.status === "stale"
              ? `Saved P/L facts are older than the 10-minute freshness window (last observed ${pnlRead.observedAt ?? "unknown"}).`
              : "This wallet is enrolled, but no saved P/L points exist for the selected interval.",
        },
      };
    }
    return {
      kind: "ok",
      value: {
        interval,
        history: pnlRead.points,
        computedAt: pnlRead.observedAt ?? requestedAt,
      },
    };
  } catch (err) {
    return {
      kind: "warn",
      warning: warning("pnl", err),
    };
  }
}

export async function getExecutionSlice(
  db: Db,
  addr: string,
  opts: {
    /** Skip price-history overlay for refresh paths that only need trade cadence. */
    includePriceHistory?: boolean;
    /** Skip the expensive trade read when the caller only needs current holdings. */
    includeTrades?: boolean;
    /** Optional asset allowlist for DB-row enrichment callers. */
    assets?: readonly string[];
  } = {}
): Promise<PolyWalletExecutionOutput> {
  const warnings: WalletExecutionWarning[] = [];
  const includeTrades = opts.includeTrades ?? true;
  const requestedAt = new Date();

  const availabilityResults = await Promise.allSettled([
    readSavedFactsAvailability(db, addr, "data-api-positions"),
    includeTrades
      ? readSavedFactsAvailability(db, addr, "data-api-trades")
      : Promise.resolve(null),
  ]);
  for (const result of availabilityResults) {
    if (result.status === "rejected") {
      warnings.push({
        code: "saved_facts_availability_unavailable",
        message:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
    } else if (result.value !== null && result.value.kind !== "ready") {
      warnings.push(savedFactsIssue(result.value));
    }
  }
  const readySources = availabilityResults.flatMap((result) =>
    result.status === "fulfilled" && result.value?.kind === "ready"
      ? [result.value]
      : []
  );
  if (warnings.length > 0) {
    return {
      address: addr.toLowerCase() as PolyWalletExecutionOutput["address"],
      freshness: "read_model",
      capturedAt: requestedAt.toISOString(),
      dailyTradeCounts: [],
      live_positions: [],
      market_groups: [],
      closed_positions: [],
      warnings,
    };
  }
  const capturedAt = new Date(
    Math.min(...readySources.map((source) => source.lastSuccessAt.getTime()))
  ).toISOString();

  const [positionsResult, tradesResult] = await Promise.allSettled([
    coalesce(
      `db-positions:${addr}`,
      () => readCurrentPositionsFromDb(db, addr),
      SLICE_TTL_MS
    ),
    includeTrades
      ? coalesce(
          `db-execution-trades:${addr}`,
          () => readFillsForActivePositionsFromDb(db, addr),
          SLICE_TTL_MS
        )
      : Promise.resolve([] as DbFillRow[]),
  ]);

  const positionRows =
    positionsResult.status === "fulfilled" ? positionsResult.value : [];
  const fillRows =
    tradesResult.status === "fulfilled" ? tradesResult.value : [];

  if (positionsResult.status === "rejected") {
    warnings.push({
      code: "positions_unavailable",
      message:
        positionsResult.reason instanceof Error
          ? positionsResult.reason.message
          : String(positionsResult.reason),
    });
  }
  if (tradesResult.status === "rejected") {
    warnings.push({
      code: "daily_trade_counts_unavailable",
      message:
        tradesResult.reason instanceof Error
          ? tradesResult.reason.message
          : String(tradesResult.reason),
    });
  }

  const positions = positionRows.map(dbPositionToUserPosition);
  const trades = fillRows.map(dbFillToUserTrade);

  const dailyTradeCountsResult = buildDailyCounts(
    trades,
    EXECUTION_HISTORY_WINDOW_DAYS
  );

  // Split all mapped positions into open/redeemable (live) vs closed before
  // fetching CLOB price history. Closed positions have a complete trade-derived
  // timeline; CLOB history is only needed for live holdings.
  const allMapped = mapExecutionPositions({
    positions,
    trades,
    asOfIso: capturedAt,
  });

  const allowedAssets = opts.assets !== undefined ? new Set(opts.assets) : null;
  const liveCandidates = allMapped
    .filter((p) => p.status === "open" || p.status === "redeemable")
    .filter((p) => allowedAssets === null || allowedAssets.has(p.asset));
  const livePreview =
    allowedAssets === null
      ? liveCandidates.slice(0, EXECUTION_OPEN_LIMIT)
      : liveCandidates;
  const closedCandidates = allMapped
    .filter((p) => p.status === "closed")
    .filter((p) => allowedAssets === null || allowedAssets.has(p.asset));
  const closedPreview =
    allowedAssets === null
      ? closedCandidates.slice(0, EXECUTION_HISTORY_LIMIT)
      : closedCandidates;

  let liveForResponse = livePreview;
  if (opts.includePriceHistory ?? true) {
    // Read per-asset price history from `poly_market_price_history` (task.5018 CP7).
    // The price-history bootstrap job is the only writer; this read is page-load
    // safe (PAGE_LOAD_DB_ONLY). Cold-start gap on a freshly-opened position
    // returns an empty series — `mapExecutionPositions` renders flat/empty
    // until the next 5-min tick ingests.
    const priceHistoryByAsset = new Map<
      string,
      Awaited<ReturnType<PolymarketClobPublicClient["getPriceHistory"]>>
    >();

    await Promise.all(
      livePreview.map(async (position) => {
        const startTs = Math.max(
          0,
          Math.floor(new Date(position.openedAt).getTime() / 1000) - 3600
        );
        const endTs = Math.floor(new Date(capturedAt).getTime() / 1000);
        const fidelity = pickStoredPriceHistoryFidelity(startTs, endTs);

        const history = await readPriceHistoryFromDb(
          db,
          position.asset,
          startTs,
          endTs,
          fidelity
        );
        if (history.length > 0) {
          priceHistoryByAsset.set(position.asset, history);
        }
      })
    );

    // Re-map live positions with stored price history timelines.
    const liveAssets = new Set(livePreview.map((p) => p.asset));
    liveForResponse = mapExecutionPositions({
      positions,
      trades,
      priceHistoryByAsset,
      asOfIso: capturedAt,
      assets: [...liveAssets],
    });
  }

  return {
    address: addr.toLowerCase() as PolyWalletExecutionOutput["address"],
    freshness: "read_model",
    capturedAt,
    dailyTradeCounts: dailyTradeCountsResult,
    live_positions: liveForResponse.map(toExecutionContractPosition),
    market_groups: [],
    closed_positions: closedPreview.map(toExecutionContractPosition),
    warnings,
  };
}

function warning(
  slice: WalletAnalysisWarning["slice"],
  err: unknown
): WalletAnalysisWarning {
  return {
    slice,
    code: "upstream_failed",
    message: err instanceof Error ? err.message : String(err),
  };
}

function toFiniteNumber(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  if (value === null || value === undefined) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalField<TKey extends string>(
  key: TKey,
  value: string | undefined
): { [K in TKey]: string } | Record<string, never> {
  return value === undefined
    ? {}
    : ({ [key]: value } as { [K in TKey]: string });
}

/**
 * Bucket trades by day and emit one row per day from `min(oldestTrade, today
 * minus minWindowDays)` through today. `minWindowDays` is a floor — fresh
 * wallets still show that many bars (mostly zeros) so the chart shape is
 * stable — but older history is never truncated. Returns an empty array when
 * `minWindowDays <= 0` and there are no trades.
 */
function buildDailyCounts(
  trades: ReadonlyArray<{ timestamp: number }>,
  minWindowDays: number
): WalletExecutionDailyCount[] {
  const SEC_PER_DAY = 86_400;
  const nowSec = Math.floor(Date.now() / 1000);
  const buckets = new Map<string, number>();
  let oldestTradeSec = Number.POSITIVE_INFINITY;
  for (const t of trades) {
    const day = new Date(t.timestamp * 1_000).toISOString().slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
    if (t.timestamp < oldestTradeSec) oldestTradeSec = t.timestamp;
  }
  const minWindowStartSec =
    minWindowDays > 0 ? nowSec - (minWindowDays - 1) * SEC_PER_DAY : nowSec;
  const startSec = Number.isFinite(oldestTradeSec)
    ? Math.min(minWindowStartSec, oldestTradeSec)
    : minWindowStartSec;
  const totalDays =
    Math.max(0, Math.floor((nowSec - startSec) / SEC_PER_DAY)) + 1;
  if (totalDays <= 0) return [];
  const out: Array<{ day: string; n: number }> = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    const day = new Date((nowSec - i * SEC_PER_DAY) * 1_000)
      .toISOString()
      .slice(0, 10);
    out.push({ day, n: buckets.get(day) ?? 0 });
  }
  return out;
}

function toExecutionContractPosition(
  position: ReturnType<typeof mapExecutionPositions>[number]
): WalletExecutionPosition {
  return {
    positionId: position.positionId,
    conditionId: position.conditionId,
    asset: position.asset,
    marketTitle: position.marketTitle,
    marketSlug: position.marketSlug,
    eventSlug: position.eventSlug,
    marketUrl: position.marketUrl,
    outcome: position.outcome,
    status: position.status,
    lifecycleState: null,
    openedAt: position.openedAt,
    closedAt: position.closedAt ?? null,
    resolvesAt: position.resolvesAt ?? null,
    heldMinutes: position.heldMinutes,
    entryPrice: position.entryPrice,
    currentPrice: position.currentPrice,
    size: position.size,
    currentValue: position.currentValue,
    pnlUsd: position.pnlUsd,
    pnlPct: position.pnlPct,
    timeline: [...position.timeline],
    events: [...position.events],
  };
}

function buildTopMarkets(
  trades: ReadonlyArray<{
    conditionId: string;
    title: string;
    timestamp: number;
  }>,
  limit: number
): string[] {
  // Newest-first dedupe by conditionId.
  const seen = new Set<string>();
  const out: string[] = [];
  const sorted = [...trades].sort((a, b) => b.timestamp - a.timestamp);
  for (const t of sorted) {
    if (seen.has(t.conditionId) || !t.title) continue;
    seen.add(t.conditionId);
    out.push(t.title);
    if (out.length >= limit) break;
  }
  return out;
}
