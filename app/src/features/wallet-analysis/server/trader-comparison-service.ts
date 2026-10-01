// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/trader-comparison-service`
 * Purpose: Builds the research trader-comparison slice from saved trader observations and Polymarket-native P/L.
 * Scope: Read-only feature service. Caller injects DB and normalized wallet inputs; this module owns no auth or HTTP parsing.
 * Invariants:
 *   - PNL_SINGLE_SOURCE: delegates to `getPnlSlice`, the same Polymarket-native source used by wallet analysis.
 *   - TRADE_FLOW_FROM_OBSERVATIONS: counts/notional are SQL windows over `poly_trader_fills`.
 *   - PAGE_LOAD_DB_ONLY: market resolutions read from `poly_market_outcomes` (CP3 writer); no synchronous CLOB call on render.
 *   - AGGREGATE_IN_SQL (bug.5008): the trade-size/P-L histogram is computed entirely in Postgres.
 *     No raw fill rows reach V8 — only ≤20 bucket rows per wallet. The legacy JS aggregation is
 *     preserved verbatim as a test-only parity oracle in `tests/_fixtures/poly/trade-size-pnl-oracle.ts`.
 *   - SNAPSHOT_CONSISTENT_BUNDLE: the per-wallet summary + size-P/L queries run inside one
 *     repeatable-read read-only transaction so histogram counts reconcile with summary totals.
 *   - ROLLUP_BACKED_FULL_HISTORY (task.research-rollup-read-models): the full-history CTEs
 *     (`token_flows`, `condition_token_costs`) and the windowed summary read
 *     `poly_trader_fill_rollups_daily` (+ unrolled tail) via `fill-rollup-service` helpers.
 *     Only `windowed_buys` still touches raw fills — the rank bucketing is per-fill by
 *     definition and window-dependent, so it cannot be pre-bucketed.
 *   - PER_WALLET_TIME_BUDGET (interim, 2026-09-28): each wallet's aggregate races a time budget
 *     (`opts.perWalletBudgetMs`, default 8s, env `POLY_RESEARCH_WALLET_BUDGET_MS`). A wallet
 *     that exceeds it is OMITTED from `traders` and surfaced as a `wallet_budget_exceeded`
 *     warning on the partial-failure-200 path. The same value is installed as a transaction-local
 *     Postgres `statement_timeout`, so losing the JS race also cancels the underlying SQL instead
 *     of leaving it to consume I/O for minutes. The real fix remains complete tick-written rollups.
 * Side-effects: DB reads plus the DB-backed P/L read performed by `getPnlSlice`.
 * Links: nodes/poly/packages/node-contracts/src/poly.research-trader-comparison.v1.contract.ts, work/items/task.5012, work/items/bug.5008
 * @public
 */

import type {
  PolyResearchTraderComparisonResponse,
  PolyResearchTraderComparisonTrader,
  PolyResearchTraderComparisonWarning,
  PolyResearchTraderSizePnl,
  PolyWalletOverviewInterval,
  PolyWalletOverviewPnlPoint,
} from "@cogni/poly-node-contracts";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  EPOCH_ISO,
  windowedFillFlowsSelect,
} from "./fill-rollup-service";
import { getPnlSlice } from "./wallet-analysis-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

export type TraderComparisonInput = {
  address: string;
  label?: string | undefined;
};

type TradeSummaryRow = {
  id: string;
  label: string;
  kind: string;
  first_observed_at: Date | string | null;
  last_success_at: Date | string | null;
  status: string | null;
  trade_count: string | number | null;
  buy_count: string | number | null;
  sell_count: string | number | null;
  notional_usdc: string | number | null;
  buy_usdc: string | number | null;
  sell_usdc: string | number | null;
  market_count: string | number | null;
};

/** One SQL-aggregated size-percentile bucket row. At most 20 rows reach V8 per wallet. */
export type TradeSizePnlBucketRow = {
  bucket_index: string | number | null;
  buy_count: string | number | null;
  buy_usdc: string | number | null;
  min_size_usdc: string | number | null;
  max_size_usdc: string | number | null;
  hedge_buy_count: string | number | null;
  hedge_buy_usdc: string | number | null;
  pending_count: string | number | null;
  resolved_count: string | number | null;
  pnl_usdc: string | number | null;
  win_count: string | number | null;
  loss_count: string | number | null;
  flat_count: string | number | null;
};

const SIZE_BUCKET_STEP = 5;
const SIZE_BUCKET_COUNT = 100 / SIZE_BUCKET_STEP;

/**
 * Default per-wallet aggregation budget. Prod (2026-09-28, build 08cedd2)
 * measured ~31s on the worst wallet. The original 25s JS-only budget let the
 * abandoned SQL run for minutes and starve readiness. Eight seconds returns a
 * pool slot before the 15s boot-SLO probe fails. Env-tunable via
 * `POLY_RESEARCH_WALLET_BUDGET_MS`.
 */
export const DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS = 8_000;

/** Warning code emitted when a wallet's aggregate exceeds the time budget. */
export const TRADER_COMPARISON_BUDGET_WARNING_CODE = "wallet_budget_exceeded";

class TraderComparisonBudgetExceededError extends Error {
  constructor(budgetMs: number) {
    super(`trader-comparison wallet aggregate exceeded ${budgetMs}ms budget`);
    this.name = "TraderComparisonBudgetExceededError";
  }
}

export async function getTraderComparison(
  db: Db,
  wallets: readonly TraderComparisonInput[],
  interval: PolyWalletOverviewInterval,
  opts: { perWalletBudgetMs?: number } = {}
): Promise<PolyResearchTraderComparisonResponse> {
  const capturedAt = new Date().toISOString();
  const budgetMs =
    opts.perWalletBudgetMs ?? DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS;
  const warnings: PolyResearchTraderComparisonWarning[] = [];
  const windowStartIso = windowStartFor(interval).toISOString();

  const results = await Promise.all(
    wallets.slice(0, 3).map(async (wallet) => {
      const address = wallet.address.toLowerCase();
      try {
        const computed = await withBudget(
          budgetMs,
          computeTrader(db, wallet, address, interval, windowStartIso, budgetMs)
        );
        // Merge only when the wallet beat the budget — a late-completing
        // computation must not mutate an already-returned warnings array.
        warnings.push(...computed.warnings);
        return computed.trader;
      } catch (err) {
        if (err instanceof TraderComparisonBudgetExceededError) {
          warnings.push({
            wallet: address as `0x${string}`,
            code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
            message: `Aggregation for ${address} exceeded the ${budgetMs}ms budget and was omitted from this response. Retry later or narrow the interval.`,
          });
          return null;
        }
        throw err;
      }
    })
  );

  return {
    interval,
    capturedAt,
    traders: results.filter((t) => t !== null),
    warnings,
  };
}

/** Per-wallet aggregate (bundle + P/L) with its own warnings, merged by the caller only when it wins the budget race. */
async function computeTrader(
  db: Db,
  wallet: TraderComparisonInput,
  address: string,
  interval: PolyWalletOverviewInterval,
  windowStartIso: string,
  budgetMs: number
): Promise<{
  trader: PolyResearchTraderComparisonTrader;
  warnings: PolyResearchTraderComparisonWarning[];
}> {
  const warnings: PolyResearchTraderComparisonWarning[] = [];
  const [bundle, pnlResult] = await Promise.all([
    readTradeBundle(db, address, windowStartIso, budgetMs),
    getPnlSlice(db, address, interval),
  ]);
  const pnlHistory = pnlResult.kind === "ok" ? [...pnlResult.value.history] : [];
  if (pnlResult.kind === "warn") {
    warnings.push({
      wallet: address as `0x${string}`,
      code: pnlResult.warning.code,
      message: pnlResult.warning.message,
    });
  }

  return {
    trader: toTrader({
      address,
      fallbackLabel: wallet.label,
      interval,
      summary: bundle.summary,
      tradeSizePnl: bundle.tradeSizePnl,
      pnlHistory,
    }),
    warnings,
  };
}

/**
 * Race `work` against the time budget. On timeout, rejects with
 * `TraderComparisonBudgetExceededError`; `work`'s eventual settlement is
 * absorbed by the already-settled promise (no unhandled rejection). The
 * bundle's matching Postgres statement_timeout cancels the aggregate at the
 * same ceiling.
 */
function withBudget<T>(budgetMs: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TraderComparisonBudgetExceededError(budgetMs));
    }, budgetMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/**
 * Runs the per-wallet summary + size-P/L aggregate queries in one repeatable-read,
 * read-only transaction so both aggregates observe the same snapshot (a fill landing
 * mid-bundle cannot make the histogram disagree with the summary totals).
 */
async function readTradeBundle(
  db: Db,
  address: string,
  windowStartIso: string,
  statementTimeoutMs: number
): Promise<{
  summary: TradeSummaryRow | null;
  tradeSizePnl: PolyResearchTraderSizePnl;
}> {
  return (db as PostgresJsDatabase<Record<string, unknown>>).transaction(
    async (tx) => {
      const txDb = tx as unknown as Db;
      await txDb.execute(
        sql.raw(
          `SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(statementTimeoutMs))}`
        )
      );
      const summary = await readTradeSummary(txDb, address, windowStartIso);
      const tradeSizePnl = await readTradeSizePnl(
        txDb,
        address,
        windowStartIso
      );
      return { summary, tradeSizePnl };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
}

/**
 * SQL-aggregated replacement for the legacy JS trade-size/P-L reducer (bug.5008).
 *
 * The whole computation stays in Postgres; only ≤20 bucket rows are hydrated.
 * Aggregate groups, one CTE each:
 *   - `windowed_buys`     — the time-windowed BUY fills, ranked by fill size.
 *   - `token_flows`       — FULL-HISTORY buy/sell USDC + shares per token that received
 *                           a windowed buy (the legacy JS computed token P/L over the
 *                           wallet's entire fill history; only bucket membership was windowed).
 *   - `condition_closed`  — per-condition resolution status from `poly_market_outcomes`,
 *                           joined ONCE (exact-match on condition_id — stored values are
 *                           normalized; see market-exposure-service.ts precedent. No lower()).
 *   - `token_pnls`        — per-token resolved flag + realized pnl (sell + winner payout − buy).
 *   - `condition_token_costs` / `hedge_tokens` — full-history BUY cost per (condition, token);
 *                           the single cheapest token of a multi-token condition is the hedge
 *                           when strictly cheaper than the most expensive one.
 *   - `bucketed` + final SELECT — per-bucket counts/sums/min/max.
 *
 * Percentile-method note (skill: data-research §6): the legacy JS did NOT compute a quantile
 * value, so neither PERCENTILE_CONT nor PERCENTILE_DISC applies. It bucketed by rank:
 * `floor((index / n) * 20)` over buys sorted ascending by size. That is not `width_bucket`
 * (value-based edges) and not `ntile` (ntile packs remainders into the leading buckets;
 * the JS formula spreads sparse counts across the range, e.g. 7 buys land in buckets
 * 0,2,5,8,11,14,17). We replicate the exact JS float expression with float8 math so the
 * bucket assignment is bit-identical to the oracle.
 *
 * Ties in size_usdc break by observed_at (the legacy stable sort preserved the
 * observed_at-ASC input order), then id for determinism.
 */
export async function readTradeSizePnl(
  db: Db,
  address: string,
  windowStartIso: string
): Promise<PolyResearchTraderSizePnl> {
  // task.research-rollup-read-models: the full-history CTEs (`token_flows`,
  // `condition_token_costs`) now read `poly_trader_fill_rollups_daily`
  // (+ the not-yet-rolled tail) via `windowedFillFlowsSelect(EPOCH)` — the
  // 100-1000x smaller derived table — instead of re-scanning the wallet's
  // entire fill history. `windowed_buys` stays per-fill BY DESIGN: the
  // bit-exact rank bucketing (floor((i/n)*20) over buys sorted by size)
  // needs individual fill sizes and cannot be pre-bucketed (window-dependent
  // ranks); see the work-item design doc.
  const walletRows = (await db.execute(sql`
    SELECT w.id FROM poly_trader_wallets w WHERE w.wallet_address = ${address} LIMIT 1
  `)) as unknown as
    | Array<Record<string, unknown>>
    | { rows?: Array<Record<string, unknown>> };
  const walletList = Array.isArray(walletRows)
    ? walletRows
    : (walletRows.rows ?? []);
  const walletId = walletList[0]?.id;
  if (typeof walletId !== "string") {
    return buildTradeSizePnlFromBucketRows([]);
  }
  const flows = windowedFillFlowsSelect({
    walletIds: [walletId],
    windowStartIso: EPOCH_ISO,
  });
  const rows = (await db.execute(sql`
    WITH windowed_buys AS (
      SELECT
        f.condition_id,
        f.token_id,
        f.size_usdc AS size_usdc,
        (ROW_NUMBER() OVER (ORDER BY f.size_usdc ASC, f.observed_at ASC, f.id ASC) - 1) AS rank0,
        COUNT(*) OVER () AS total_buys
      FROM poly_trader_fills f
      WHERE f.trader_wallet_id = ${walletId}::uuid
        AND f.side = 'BUY'
        AND f.observed_at >= ${windowStartIso}::timestamptz
    ),
    all_flows AS (${flows}),
    token_flows AS (
      SELECT
        fl.token_id,
        MIN(fl.condition_id) AS condition_id,
        COALESCE(SUM(fl.buy_usdc), 0) AS buy_usdc,
        COALESCE(SUM(fl.sell_usdc), 0) AS sell_usdc,
        COALESCE(SUM(fl.buy_shares), 0) AS buy_shares,
        COALESCE(SUM(fl.sell_shares), 0) AS sell_shares
      FROM all_flows fl
      WHERE fl.token_id IN (SELECT DISTINCT token_id FROM windowed_buys)
      GROUP BY fl.token_id
    ),
    condition_closed AS (
      SELECT
        o.condition_id,
        BOOL_AND(o.outcome <> 'unknown') AS closed
      FROM poly_market_outcomes o
      WHERE o.condition_id IN (SELECT DISTINCT condition_id FROM windowed_buys)
      GROUP BY o.condition_id
    ),
    token_pnls AS (
      SELECT
        tf.token_id,
        tf.buy_usdc,
        (COALESCE(cc.closed, false) AND o.token_id IS NOT NULL) AS resolved,
        CASE
          WHEN COALESCE(cc.closed, false) AND o.token_id IS NOT NULL
          THEN tf.sell_usdc
               + CASE
                   WHEN (tf.buy_shares - tf.sell_shares) > 0 AND o.outcome = 'winner'
                   THEN tf.buy_shares - tf.sell_shares
                   ELSE 0
                 END
               - tf.buy_usdc
          ELSE 0
        END AS pnl
      FROM token_flows tf
      LEFT JOIN condition_closed cc
        ON cc.condition_id = tf.condition_id
      LEFT JOIN poly_market_outcomes o
        ON o.condition_id = tf.condition_id
        AND o.token_id = tf.token_id
    ),
    condition_token_costs AS (
      -- Legacy grouped BUY fills only; flow rows carry per-side sums, so
      -- SUM(buy_usdc) + MIN(first_buy_observed_at) reproduce it exactly and
      -- the HAVING drops (condition, token) groups that never had a BUY.
      SELECT
        fl.condition_id,
        fl.token_id,
        SUM(fl.buy_usdc) AS buy_usdc,
        MIN(fl.first_buy_observed_at) AS first_buy_at
      FROM all_flows fl
      WHERE fl.condition_id IN (SELECT DISTINCT condition_id FROM windowed_buys)
      GROUP BY fl.condition_id, fl.token_id
      HAVING SUM(fl.buy_count) > 0
    ),
    hedge_tokens AS (
      SELECT token_id
      FROM (
        SELECT
          token_id,
          buy_usdc,
          ROW_NUMBER() OVER (
            PARTITION BY condition_id
            ORDER BY buy_usdc ASC, first_buy_at ASC
          ) AS cost_rank,
          COUNT(*) OVER (PARTITION BY condition_id) AS token_count,
          MAX(buy_usdc) OVER (PARTITION BY condition_id) AS max_cost
        FROM condition_token_costs
      ) ranked
      WHERE cost_rank = 1
        AND token_count >= 2
        AND buy_usdc < max_cost
    ),
    contributions AS (
      SELECT
        -- Exact replica of the legacy JS Math.floor((index / Math.max(1, n)) * 20),
        -- capped at 19: float8 division/multiplication is IEEE-754 double, identical to V8.
        LEAST(
          19,
          FLOOR((b.rank0::float8 / GREATEST(b.total_buys, 1)::float8) * 20)
        )::int AS bucket_index,
        b.size_usdc,
        tp.resolved,
        -- Legacy JS: (fill.sizeUsdc / Math.max(tokenPnl.buyUsdc, 1)) * tokenPnl.pnl
        (b.size_usdc / GREATEST(tp.buy_usdc, 1) * tp.pnl) AS pnl_contribution,
        (h.token_id IS NOT NULL) AS is_hedge
      FROM windowed_buys b
      INNER JOIN token_pnls tp
        ON tp.token_id = b.token_id
      LEFT JOIN hedge_tokens h
        ON h.token_id = b.token_id
    )
    SELECT
      c.bucket_index,
      COUNT(*)::int AS buy_count,
      SUM(c.size_usdc) AS buy_usdc,
      MIN(c.size_usdc) AS min_size_usdc,
      MAX(c.size_usdc) AS max_size_usdc,
      COUNT(*) FILTER (WHERE c.is_hedge)::int AS hedge_buy_count,
      COALESCE(SUM(c.size_usdc) FILTER (WHERE c.is_hedge), 0) AS hedge_buy_usdc,
      COUNT(*) FILTER (WHERE NOT c.resolved)::int AS pending_count,
      COUNT(*) FILTER (WHERE c.resolved)::int AS resolved_count,
      COALESCE(SUM(c.pnl_contribution) FILTER (WHERE c.resolved), 0) AS pnl_usdc,
      COUNT(*) FILTER (WHERE c.resolved AND c.pnl_contribution > 0.5)::int AS win_count,
      COUNT(*) FILTER (WHERE c.resolved AND c.pnl_contribution < -0.5)::int AS loss_count,
      COUNT(*) FILTER (
        WHERE c.resolved AND c.pnl_contribution >= -0.5 AND c.pnl_contribution <= 0.5
      )::int AS flat_count
    FROM contributions c
    GROUP BY c.bucket_index
    ORDER BY c.bucket_index
  `)) as unknown as TradeSizePnlBucketRow[];

  return buildTradeSizePnlFromBucketRows(rows);
}

/**
 * Rollup-backed since task.research-rollup-read-models: windowed counts/
 * notional/market-count come from `poly_trader_fill_rollups_daily`
 * (+ boundary/tail fills) instead of the legacy LEFT JOIN aggregate that
 * walked every fill row in the window (the wallet's whole history on ALL).
 * Two statements inside the caller's repeatable-read `readTradeBundle`
 * transaction, so they share one snapshot with the size-P/L query.
 *
 * @internal — exported for the rollup parity tests only.
 */
export async function readTradeSummary(
  db: Db,
  address: string,
  windowStartIso: string
): Promise<TradeSummaryRow | null> {
  const metaRows = (await db.execute(sql`
    SELECT
      w.id,
      w.label,
      w.kind,
      w.first_observed_at,
      c.last_success_at,
      c.status
    FROM poly_trader_wallets w
    LEFT JOIN poly_trader_ingestion_cursors c
      ON c.trader_wallet_id = w.id
      AND c.source = 'data-api-trades'
    WHERE w.wallet_address = ${address}
    LIMIT 1
  `)) as unknown as
    | Array<Record<string, unknown>>
    | { rows?: Array<Record<string, unknown>> };
  const metaList = Array.isArray(metaRows) ? metaRows : (metaRows.rows ?? []);
  const meta = metaList[0];
  if (!meta || typeof meta.id !== "string") return null;

  const flows = windowedFillFlowsSelect({
    walletIds: [meta.id],
    windowStartIso,
  });
  const aggRows = (await db.execute(sql`
    SELECT
      COALESCE(SUM(fl.fill_count), 0) AS trade_count,
      COALESCE(SUM(fl.buy_count), 0) AS buy_count,
      COALESCE(SUM(fl.sell_count), 0) AS sell_count,
      COALESCE(SUM(fl.buy_usdc + fl.sell_usdc), 0) AS notional_usdc,
      COALESCE(SUM(fl.buy_usdc), 0) AS buy_usdc,
      COALESCE(SUM(fl.sell_usdc), 0) AS sell_usdc,
      COUNT(DISTINCT fl.condition_id) AS market_count
    FROM (${flows}) fl
  `)) as unknown as
    | Array<Record<string, unknown>>
    | { rows?: Array<Record<string, unknown>> };
  const aggList = Array.isArray(aggRows) ? aggRows : (aggRows.rows ?? []);
  const agg = aggList[0] ?? {};

  return {
    id: meta.id,
    label: String(meta.label ?? ""),
    kind: String(meta.kind ?? ""),
    first_observed_at:
      (meta.first_observed_at as Date | string | null | undefined) ?? null,
    last_success_at:
      (meta.last_success_at as Date | string | null | undefined) ?? null,
    status: (meta.status as string | null | undefined) ?? null,
    trade_count: (agg.trade_count as string | number | null | undefined) ?? 0,
    buy_count: (agg.buy_count as string | number | null | undefined) ?? 0,
    sell_count: (agg.sell_count as string | number | null | undefined) ?? 0,
    notional_usdc:
      (agg.notional_usdc as string | number | null | undefined) ?? 0,
    buy_usdc: (agg.buy_usdc as string | number | null | undefined) ?? 0,
    sell_usdc: (agg.sell_usdc as string | number | null | undefined) ?? 0,
    market_count: (agg.market_count as string | number | null | undefined) ?? 0,
  };
}

function toTrader(params: {
  address: string;
  fallbackLabel?: string | undefined;
  interval: PolyWalletOverviewInterval;
  summary: TradeSummaryRow | null;
  tradeSizePnl: PolyResearchTraderSizePnl;
  pnlHistory: PolyWalletOverviewPnlPoint[];
}): PolyResearchTraderComparisonTrader {
  const summary = params.summary;
  const label =
    params.fallbackLabel?.trim() ||
    summary?.label ||
    shortAddress(params.address);
  return {
    address: params.address as `0x${string}`,
    label,
    isObserved: Boolean(summary),
    traderKind:
      summary?.kind === "copy_target" || summary?.kind === "cogni_wallet"
        ? summary.kind
        : null,
    interval: params.interval,
    observedSince: toIsoString(summary?.first_observed_at),
    lastObservedAt: toIsoString(summary?.last_success_at),
    observationStatus: summary?.status ?? null,
    pnl: {
      usdc: computeWindowedPnl(params.pnlHistory),
      history: params.pnlHistory,
    },
    trades: {
      count: toInteger(summary?.trade_count),
      buyCount: toInteger(summary?.buy_count),
      sellCount: toInteger(summary?.sell_count),
      notionalUsdc: toNumber(summary?.notional_usdc),
      buyUsdc: toNumber(summary?.buy_usdc),
      sellUsdc: toNumber(summary?.sell_usdc),
      marketCount: toInteger(summary?.market_count),
    },
    tradeSizePnl: params.tradeSizePnl,
  };
}

/**
 * Maps the ≤20 SQL bucket rows onto the fixed 20-bucket contract shape, then applies
 * the same finalize (rounding, avg, winRate) and totals reduction the legacy JS used.
 * Totals intentionally sum the ROUNDED bucket values — identical to the legacy reducer,
 * proven by the parity oracle test.
 * Exported for unit tests; only `readTradeSizePnl` calls it in production.
 */
export function buildTradeSizePnlFromBucketRows(
  rows: readonly TradeSizePnlBucketRow[]
): PolyResearchTraderSizePnl {
  const buckets = emptyTradeSizePnl().buckets.map((bucket) => ({ ...bucket }));
  for (const row of rows) {
    const bucket = buckets[toInteger(row.bucket_index)];
    if (!bucket) continue;
    bucket.buyCount = toInteger(row.buy_count);
    bucket.buyUsdc = toNumber(row.buy_usdc);
    // Legacy JS accumulated avgSizeUsdc and buyUsdc from the same per-fill sizes;
    // the finalize step below divides by buyCount.
    bucket.avgSizeUsdc = toNumber(row.buy_usdc);
    bucket.minSizeUsdc = toNumber(row.min_size_usdc);
    bucket.maxSizeUsdc = toNumber(row.max_size_usdc);
    bucket.hedgeBuyCount = toInteger(row.hedge_buy_count);
    bucket.hedgeBuyUsdc = toNumber(row.hedge_buy_usdc);
    bucket.pendingCount = toInteger(row.pending_count);
    bucket.resolvedCount = toInteger(row.resolved_count);
    bucket.pnlUsdc = toNumber(row.pnl_usdc);
    bucket.winCount = toInteger(row.win_count);
    bucket.lossCount = toInteger(row.loss_count);
    bucket.flatCount = toInteger(row.flat_count);
  }

  const finalized = buckets.map((bucket) => ({
    ...bucket,
    avgSizeUsdc:
      bucket.buyCount > 0 ? roundMoney(bucket.avgSizeUsdc / bucket.buyCount) : 0,
    minSizeUsdc: bucket.buyCount > 0 ? roundMoney(bucket.minSizeUsdc) : 0,
    maxSizeUsdc: bucket.buyCount > 0 ? roundMoney(bucket.maxSizeUsdc) : 0,
    buyUsdc: roundMoney(bucket.buyUsdc),
    hedgeBuyUsdc: roundMoney(bucket.hedgeBuyUsdc),
    pnlUsdc: roundMoney(bucket.pnlUsdc),
    winRate:
      bucket.winCount + bucket.lossCount > 0
        ? bucket.winCount / (bucket.winCount + bucket.lossCount)
        : null,
  }));

  const totals = finalized.reduce(
    (acc, bucket) => ({
      sampleBuyCount: acc.sampleBuyCount + bucket.buyCount,
      resolvedCount: acc.resolvedCount + bucket.resolvedCount,
      winCount: acc.winCount + bucket.winCount,
      lossCount: acc.lossCount + bucket.lossCount,
      flatCount: acc.flatCount + bucket.flatCount,
      pendingCount: acc.pendingCount + bucket.pendingCount,
      pnlUsdc: acc.pnlUsdc + bucket.pnlUsdc,
      buyUsdc: acc.buyUsdc + bucket.buyUsdc,
      hedgeBuyCount: acc.hedgeBuyCount + bucket.hedgeBuyCount,
      hedgeBuyUsdc: acc.hedgeBuyUsdc + bucket.hedgeBuyUsdc,
    }),
    {
      sampleBuyCount: 0,
      resolvedCount: 0,
      winCount: 0,
      lossCount: 0,
      flatCount: 0,
      pendingCount: 0,
      pnlUsdc: 0,
      buyUsdc: 0,
      hedgeBuyCount: 0,
      hedgeBuyUsdc: 0,
    }
  );

  return {
    bucketStep: SIZE_BUCKET_STEP,
    ...totals,
    pnlUsdc: roundMoney(totals.pnlUsdc),
    buyUsdc: roundMoney(totals.buyUsdc),
    hedgeBuyUsdc: roundMoney(totals.hedgeBuyUsdc),
    winRate:
      totals.winCount + totals.lossCount > 0
        ? totals.winCount / (totals.winCount + totals.lossCount)
        : null,
    buckets: finalized,
  };
}

function emptyTradeSizePnl(): PolyResearchTraderSizePnl {
  const buckets = Array.from({ length: SIZE_BUCKET_COUNT }, (_, index) => {
    const lo = index * SIZE_BUCKET_STEP;
    const hi = lo + SIZE_BUCKET_STEP;
    return {
      key: `p${lo}_p${hi}`,
      label: `p${lo}-p${hi}`,
      loPercentile: lo,
      hiPercentile: hi,
      minSizeUsdc: 0,
      maxSizeUsdc: 0,
      avgSizeUsdc: 0,
      buyCount: 0,
      resolvedCount: 0,
      winCount: 0,
      lossCount: 0,
      flatCount: 0,
      pendingCount: 0,
      winRate: null,
      pnlUsdc: 0,
      buyUsdc: 0,
      hedgeBuyCount: 0,
      hedgeBuyUsdc: 0,
    };
  });
  return {
    bucketStep: SIZE_BUCKET_STEP,
    sampleBuyCount: 0,
    resolvedCount: 0,
    winCount: 0,
    lossCount: 0,
    flatCount: 0,
    pendingCount: 0,
    winRate: null,
    pnlUsdc: 0,
    buyUsdc: 0,
    hedgeBuyCount: 0,
    hedgeBuyUsdc: 0,
    buckets,
  };
}

export function computeWindowedPnl(
  history: readonly PolyWalletOverviewPnlPoint[]
): number | null {
  if (history.length < 2) return null;
  const first = history[0];
  const last = history.at(-1);
  if (!first || !last) return null;
  return Number((last.pnl - first.pnl).toFixed(8));
}

function windowStartFor(interval: PolyWalletOverviewInterval): Date {
  const now = Date.now();
  switch (interval) {
    case "1D":
      return new Date(now - 24 * 60 * 60 * 1000);
    case "1W":
      return new Date(now - 7 * 24 * 60 * 60 * 1000);
    case "1M":
      return new Date(now - 30 * 24 * 60 * 60 * 1000);
    case "1Y":
      return new Date(now - 365 * 24 * 60 * 60 * 1000);
    case "YTD":
      return new Date(new Date().getFullYear(), 0, 1);
    case "ALL":
      return new Date(0);
  }
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toInteger(value: string | number | null | undefined): number {
  return Math.max(0, Math.trunc(toNumber(value)));
}

function roundMoney(value: number): number {
  return Number(value.toFixed(8));
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
