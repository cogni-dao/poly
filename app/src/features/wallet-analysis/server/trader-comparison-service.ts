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
 *   - CONDITION_PUSHDOWN (fix/comparison-flows-pushdown): per wallet, ONE repeatable-read
 *     transaction, two statements. S1 reads the DISTINCT windowed-buy condition ids (bounded
 *     by the window; dozens at 1W). S2 is the P/L statement with the flows fragment scoped to
 *     S1's set via the existing `windowedFillFlowsSelect({ conditionIds })` param, so Postgres
 *     prunes the rollup aggregation BEFORE materializing `all_flows` (which is referenced
 *     twice and was otherwise materialized over the wallet's lifetime rollup rows — prod
 *     2026-10-06 measured 25.7s cold for RN1 at 1M and 1D, burning the whole wallet budget).
 *     Results are identical to the legacy unscoped statement: it computed lifetime flows and
 *     then filtered to windowed-buy conditions/tokens — the restriction merely moves ahead of
 *     materialization (and the downstream CTE filters are kept). Same-snapshot S1+S2 keeps
 *     the derived set consistent with `windowed_buys`.
 *   - PER_WALLET_TIME_BUDGET (interim, 2026-09-28): each wallet's aggregate races a time budget
 *     (`opts.perWalletBudgetMs`, default 8s, env `POLY_RESEARCH_WALLET_BUDGET_MS`). A wallet
 *     that exceeds it is OMITTED from `traders` and surfaced as a `wallet_budget_exceeded`
 *     warning on the partial-failure-200 path. The same value is installed as a transaction-local
 *     Postgres `statement_timeout`, so losing the JS race also cancels the underlying SQL instead
 *     of leaving it to consume I/O for minutes. The real fix remains complete tick-written rollups.
 *   - PER_WALLET_UNIT (fix/comparison-per-wallet-cache): the budgeted per-wallet aggregate is
 *     exposed as `computeTraderComparisonWallet(db, address, interval)` so the cache layer can
 *     key on (wallet, interval) instead of the whole 3-wallet response. `getTraderComparison`
 *     is now a thin compose: per-wallet computes + `assembleTraderComparison`.
 *   - LABELS_ARE_PRESENTATION: request labels do NOT reach the per-wallet compute. The computed
 *     trader's `label` is the stored observation label (or the short address), and the requested
 *     label is re-stamped positionally at assembly — so two users naming the same wallet
 *     differently share one cached compute.
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

/**
 * One wallet's budgeted comparison aggregate — the per-(wallet, interval)
 * cache unit. `trader` is null when the wallet exceeded its time budget (the
 * matching `wallet_budget_exceeded` warning is in `warnings`); non-budget
 * warnings (e.g. `pnl_unavailable`) ride along with a non-null trader.
 */
export type TraderComparisonWalletResult = {
  /** Lowercased wallet address the aggregate was computed for. */
  address: `0x${string}`;
  /** Compute time of THIS wallet's aggregate (cache entries age independently). */
  capturedAt: string;
  trader: PolyResearchTraderComparisonTrader | null;
  warnings: PolyResearchTraderComparisonWarning[];
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
 * CONDITION_PUSHDOWN bind-parameter guard: each pushed-down condition id is a
 * bound parameter at three places inside `windowedFillFlowsSelect`, and the
 * pg wire protocol caps a statement at 65535 binds. 5k ids ⇒ ≤15k binds with
 * ample headroom. Windows that exceed this are lifetime-scale, where the
 * pushdown saves nothing — the fragment then stays unscoped (legacy shape),
 * protected by the per-wallet budget / statement_timeout.
 */
const MAX_PUSHDOWN_CONDITION_IDS = 5_000;

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

function isStatementTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "57014" &&
    error.message.includes("statement timeout")
  );
}

export async function getTraderComparison(
  db: Db,
  wallets: readonly TraderComparisonInput[],
  interval: PolyWalletOverviewInterval,
  opts: { perWalletBudgetMs?: number } = {}
): Promise<PolyResearchTraderComparisonResponse> {
  const inputs = wallets.slice(0, 3);
  const results = await Promise.all(
    inputs.map((wallet) =>
      computeTraderComparisonWallet(db, wallet.address, interval, opts)
    )
  );
  return assembleTraderComparison(interval, inputs, results);
}

/**
 * The per-wallet cache unit (PER_WALLET_UNIT): one wallet's budgeted aggregate
 * for one interval, label-free (LABELS_ARE_PRESENTATION). A budget/statement
 * timeout degrades to `{trader: null}` plus a `wallet_budget_exceeded` warning
 * instead of throwing, so the caller/cache layer can tell "degraded" (serve,
 * never cache) from "failed" (throw, evict). `capturedAt` is the compute time —
 * per-wallet cache entries age independently.
 */
export async function computeTraderComparisonWallet(
  db: Db,
  walletAddress: string,
  interval: PolyWalletOverviewInterval,
  opts: { perWalletBudgetMs?: number } = {}
): Promise<TraderComparisonWalletResult> {
  const address = walletAddress.toLowerCase() as `0x${string}`;
  const budgetMs =
    opts.perWalletBudgetMs ?? DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS;
  const capturedAt = new Date().toISOString();
  const windowStartIso = windowStartFor(interval).toISOString();
  try {
    const computed = await withBudget(
      budgetMs,
      computeTrader(db, address, interval, windowStartIso, budgetMs)
    );
    return {
      address,
      capturedAt,
      trader: computed.trader,
      warnings: computed.warnings,
    };
  } catch (err) {
    if (
      err instanceof TraderComparisonBudgetExceededError ||
      isStatementTimeout(err)
    ) {
      // Observability: name which ceiling fired — the Postgres
      // statement_timeout (SQLSTATE 57014) or the JS budget race — so a
      // degraded wallet in logs/payloads is attributable without a repro.
      const cause = isStatementTimeout(err)
        ? "sql_statement_timeout"
        : "js_budget_race";
      return {
        address,
        capturedAt,
        trader: null,
        warnings: [
          {
            wallet: address,
            code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
            message: `Aggregation for ${address} exceeded the ${budgetMs}ms budget (${cause}) and was omitted from this response. Retry later or narrow the interval.`,
          },
        ],
      };
    }
    throw err;
  }
}

/**
 * Cheap response assembly over per-wallet results. `results[i]` must correspond
 * to `inputs[i]` (positional, like the request's wallet/label pairing).
 * Re-stamps the requested label over the computed one (LABELS_ARE_PRESENTATION;
 * the computed label is already `stored label || short address`, i.e. the legacy
 * fallback chain's tail), drops budget-degraded wallets, merges warnings in
 * input order, and reports the OLDEST per-wallet `capturedAt` so a response
 * assembled from cached entries is honest about its staleness.
 */
export function assembleTraderComparison(
  interval: PolyWalletOverviewInterval,
  inputs: readonly TraderComparisonInput[],
  results: readonly TraderComparisonWalletResult[]
): PolyResearchTraderComparisonResponse {
  const traders: PolyResearchTraderComparisonTrader[] = [];
  const warnings: PolyResearchTraderComparisonWarning[] = [];
  results.forEach((result, index) => {
    warnings.push(...result.warnings);
    if (!result.trader) return;
    const requestedLabel = inputs[index]?.label?.trim();
    traders.push(
      requestedLabel
        ? { ...result.trader, label: requestedLabel }
        : result.trader
    );
  });
  const capturedAt =
    results.map((r) => r.capturedAt).sort()[0] ?? new Date().toISOString();
  return { interval, capturedAt, traders, warnings };
}

/** Per-wallet aggregate (bundle + P/L) with its own warnings, merged by the caller only when it wins the budget race. */
async function computeTrader(
  db: Db,
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

  // CONDITION_PUSHDOWN S1 (fix/comparison-flows-pushdown): the windowed-buy
  // condition set, bounded by the window (uses the (trader_wallet_id,
  // observed_at) index; dozens of ids at 1W). Threading it into the flows
  // fragment makes S2 read rollup rows for windowed conditions × tokens ×
  // days-held (thousands) instead of the wallet's lifetime rollup
  // (10^5–10^6 rows), which PG otherwise materializes in full because
  // `all_flows` is referenced twice (token_flows + condition_token_costs) —
  // the downstream `IN (SELECT ... FROM windowed_buys)` prunes came too late.
  // Snapshot consistency: S1 and S2 run inside the caller's repeatable-read
  // transaction (`readTradeBundle`), so the set matches `windowed_buys`.
  // ALL-interval note: the pushdown is a no-op there (the windowed set
  // converges on the lifetime set) AND `windowed_buys`' per-fill ranking is
  // inherently O(lifetime buys) — ALL stays budget-protected. Phase 2
  // (separate work item, not built here): a lifetime rollup level at
  // (wallet, condition, token).
  const conditionRows = (await db.execute(sql`
    SELECT DISTINCT f.condition_id
    FROM poly_trader_fills f
    WHERE f.trader_wallet_id = ${walletId}::uuid
      AND f.side = 'BUY'
      AND f.observed_at >= ${windowStartIso}::timestamptz
  `)) as unknown as
    | Array<Record<string, unknown>>
    | { rows?: Array<Record<string, unknown>> };
  const conditionList = Array.isArray(conditionRows)
    ? conditionRows
    : (conditionRows.rows ?? []);
  const conditionIds = conditionList
    .map((row) => row.condition_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (conditionIds.length === 0) {
    // No windowed buys ⇒ `windowed_buys` is empty ⇒ every downstream CTE is
    // empty ⇒ the legacy statement returned zero bucket rows. Short-circuit
    // to the identical empty shape without materializing any flows.
    return buildTradeSizePnlFromBucketRows([]);
  }
  const flows = windowedFillFlowsSelect({
    walletIds: [walletId],
    windowStartIso: EPOCH_ISO,
    // Bind-parameter guard: the condition list is inlined as parameters at
    // three places inside the fragment. Above the cap (only wide windows on
    // power wallets, where the pushdown is a no-op anyway) fall back to the
    // legacy unscoped fragment — bit-identical output either way, since the
    // downstream CTE filters below are unchanged.
    ...(conditionIds.length <= MAX_PUSHDOWN_CONDITION_IDS
      ? { conditionIds }
      : {}),
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
  interval: PolyWalletOverviewInterval;
  summary: TradeSummaryRow | null;
  tradeSizePnl: PolyResearchTraderSizePnl;
  pnlHistory: PolyWalletOverviewPnlPoint[];
}): PolyResearchTraderComparisonTrader {
  const summary = params.summary;
  // LABELS_ARE_PRESENTATION: no request label here — the computed label is the
  // legacy fallback chain's tail; `assembleTraderComparison` re-stamps the
  // requested label over it at response assembly.
  const label = summary?.label || shortAddress(params.address);
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
