// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/_fixtures/poly/research-live-scan-oracles`
 * Purpose: Test-only parity oracles for the rollup migration
 *   (task.research-rollup-read-models + dashboard floor audit wave C).
 *   These are VERBATIM copies of the pre-rollup full-fills-scan SQL readers:
 *   the four research services through commit 51f1cb8 — snapshot position
 *   aggregates (`wallet-analysis-service.readPositionAggregatesFromDb`),
 *   benchmark summary + market rows (`copy-target-benchmark-service`),
 *   target-overlap rows (`target-overlap-service.readOverlapRows`), the
 *   trader-comparison trade summary
 *   (`trader-comparison-service.readTradeSummary`) — plus the two dashboard
 *   live-scans ported in wave C: the wallet token-P/L fills aggregation
 *   (`realized-pnl-service.readWalletTokenPnlMap`) and the market-exposure
 *   per-(wallet, condition, token) fill rollup
 *   (`market-exposure-service.readFillRollups`).
 * Scope: Oracle SQL only. No caching, no composition — the parity tests run
 *   these against the same seeded testcontainers Postgres as the rollup-backed
 *   readers and require exact equality.
 * Invariants:
 *   - ORACLE_IS_TRUTH: on mismatch, fix the rollup reader or the fixture —
 *     never the oracle (data-research skill § 5).
 * Side-effects: IO (test database reads)
 * Links: app/tests/component/db/fill-rollup-read-parity.int.test.ts,
 *   work/items/task.research-rollup-read-models.md
 * @internal
 */

import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { liveCurrentPositionSql } from "@/features/wallet-analysis/server/current-position-staleness";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

function listFromExecute(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return (
    ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) || []
  );
}

/** Legacy snapshot per-(condition, token) aggregate — full fills scan. */
export async function readPositionAggregatesOracle(
  db: Db,
  walletAddrLower: string
): Promise<
  Array<{
    conditionId: string;
    tokenId: string;
    buyUsdc: number;
    sellUsdc: number;
    buyShares: number;
    sellShares: number;
    firstBuyTs: number;
    lastTs: number;
  }>
> {
  const rows = await db.execute(sql`
    SELECT
      f.condition_id AS "conditionId",
      f.token_id AS "tokenId",
      COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'BUY'), 0)::float8  AS "buyUsdc",
      COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'SELL'), 0)::float8 AS "sellUsdc",
      COALESCE(SUM(f.shares)    FILTER (WHERE f.side = 'BUY'), 0)::float8  AS "buyShares",
      COALESCE(SUM(f.shares)    FILTER (WHERE f.side = 'SELL'), 0)::float8 AS "sellShares",
      COALESCE(EXTRACT(EPOCH FROM MIN(f.observed_at) FILTER (WHERE f.side = 'BUY')), -1)::float8 AS "firstBuyTs",
      EXTRACT(EPOCH FROM MAX(f.observed_at))::float8 AS "lastTs"
    FROM poly_trader_fills f
    INNER JOIN poly_trader_wallets w ON w.id = f.trader_wallet_id
    WHERE w.wallet_address = ${walletAddrLower}
    GROUP BY f.condition_id, f.token_id
  `);
  return listFromExecute(rows).map((r) => ({
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

export type BenchmarkSummaryOracleRow = {
  target_open_value_usdc: string | number | null;
  cogni_open_value_usdc: string | number | null;
  target_trades: string | number | null;
  cogni_trades: string | number | null;
};

/** Legacy benchmark summary — windowed COUNT(*) scalar subselects over fills. */
export async function readBenchmarkSummaryOracle(
  db: Db,
  targetWalletId: string,
  comparisonWalletId: string | null,
  windowStartIso: string
): Promise<BenchmarkSummaryOracleRow[]> {
  const rows = await db.execute(sql`
    WITH latest_positions AS (
      SELECT DISTINCT ON (p.trader_wallet_id, p.condition_id, p.token_id)
        p.trader_wallet_id,
        p.current_value_usdc::numeric AS current_value_usdc,
        w.kind
      FROM poly_trader_current_positions p
      JOIN poly_trader_wallets w ON w.id = p.trader_wallet_id
      WHERE ${liveCurrentPositionSql("p")}
        AND p.trader_wallet_id IN (${targetWalletId}, ${comparisonWalletId})
      ORDER BY p.trader_wallet_id, p.condition_id, p.token_id, p.last_observed_at DESC
    )
      SELECT
        COALESCE(SUM(current_value_usdc) FILTER (WHERE trader_wallet_id = ${targetWalletId}), 0) AS target_open_value_usdc,
        COALESCE(SUM(current_value_usdc) FILTER (WHERE trader_wallet_id = ${comparisonWalletId}), 0) AS cogni_open_value_usdc,
        (SELECT COUNT(*) FROM poly_trader_fills WHERE trader_wallet_id = ${targetWalletId} AND observed_at >= ${windowStartIso}::timestamptz) AS target_trades,
        (SELECT COUNT(*) FROM poly_trader_fills WHERE trader_wallet_id = ${comparisonWalletId} AND observed_at >= ${windowStartIso}::timestamptz) AS cogni_trades
      FROM latest_positions
  `);
  return listFromExecute(rows) as unknown as BenchmarkSummaryOracleRow[];
}

export type BenchmarkMarketOracleRow = {
  condition_id: string;
  token_id: string;
  target_vwap: string | number | null;
  cogni_vwap: string | number | null;
  target_size_usdc: string | number | null;
  cogni_size_usdc: string | number | null;
};

/** Legacy benchmark per-market VWAP rows — windowed GROUP BY over fills. */
export async function readBenchmarkMarketRowsOracle(
  db: Db,
  targetWalletId: string,
  comparisonWalletId: string | null,
  windowStartIso: string
): Promise<BenchmarkMarketOracleRow[]> {
  const rows = await db.execute(sql`
    WITH target AS (
      SELECT
        condition_id,
        token_id,
        SUM(size_usdc::numeric) AS size_usdc,
        SUM(shares::numeric) AS shares,
        SUM(size_usdc::numeric) / NULLIF(SUM(shares::numeric), 0) AS vwap
      FROM poly_trader_fills
      WHERE trader_wallet_id = ${targetWalletId}
        AND observed_at >= ${windowStartIso}::timestamptz
      GROUP BY condition_id, token_id
    ),
    cogni AS (
      SELECT
        f.condition_id,
        f.token_id,
        SUM(f.size_usdc::numeric) AS size_usdc,
        SUM(f.shares::numeric) AS shares,
        SUM(f.size_usdc::numeric) / NULLIF(SUM(f.shares::numeric), 0) AS vwap
      FROM poly_trader_fills f
      WHERE f.trader_wallet_id = ${comparisonWalletId}
        AND f.observed_at >= ${windowStartIso}::timestamptz
      GROUP BY f.condition_id, f.token_id
    )
    SELECT
      target.condition_id,
      target.token_id,
      target.vwap AS target_vwap,
      cogni.vwap AS cogni_vwap,
      target.size_usdc AS target_size_usdc,
      COALESCE(cogni.size_usdc, 0) AS cogni_size_usdc
    FROM target
    LEFT JOIN cogni ON cogni.condition_id = target.condition_id
      AND cogni.token_id = target.token_id
    ORDER BY target.size_usdc DESC
    LIMIT 100
  `);
  return listFromExecute(rows) as unknown as BenchmarkMarketOracleRow[];
}

export type OverlapOracleRow = Record<string, unknown>;

/** Legacy target-overlap aggregate — full-history fills join per bucket. */
export async function readOverlapRowsOracle(
  db: Db,
  rn1WalletId: string | null,
  swisstonyWalletId: string | null,
  windowStartIso: string
): Promise<OverlapOracleRow[]> {
  const rows = await db.execute(sql`
    WITH current_positions AS (
      SELECT
        CASE
          WHEN p.trader_wallet_id = ${rn1WalletId} THEN 'rn1'
          WHEN p.trader_wallet_id = ${swisstonyWalletId} THEN 'swisstony'
        END AS wallet_key,
        p.condition_id,
        p.token_id,
        p.current_value_usdc::numeric AS current_value_usdc
      FROM poly_trader_current_positions p
      WHERE ${liveCurrentPositionSql("p")}
        AND p.trader_wallet_id IN (${rn1WalletId}, ${swisstonyWalletId})
    ),
    markets AS (
      SELECT
        condition_id,
        CASE
          WHEN bool_or(wallet_key = 'rn1') AND bool_or(wallet_key = 'swisstony') THEN 'shared'
          WHEN bool_or(wallet_key = 'rn1') THEN 'rn1_only'
          ELSE 'swisstony_only'
        END AS bucket,
        bool_or(wallet_key = 'rn1') AS rn1_active,
        bool_or(wallet_key = 'swisstony') AS swisstony_active,
        COUNT(*) AS position_count,
        COUNT(*) FILTER (WHERE wallet_key = 'rn1') AS rn1_position_count,
        COUNT(*) FILTER (WHERE wallet_key = 'swisstony') AS swisstony_position_count,
        COALESCE(SUM(current_value_usdc), 0) AS current_value_usdc,
        COALESCE(SUM(current_value_usdc) FILTER (WHERE wallet_key = 'rn1'), 0) AS rn1_current_value_usdc,
        COALESCE(SUM(current_value_usdc) FILTER (WHERE wallet_key = 'swisstony'), 0) AS swisstony_current_value_usdc
      FROM current_positions
      WHERE wallet_key IS NOT NULL
      GROUP BY condition_id
    ),
    volumes AS (
      SELECT
        m.bucket,
        COALESCE(SUM(f.size_usdc::numeric) FILTER (
          WHERE (m.bucket = 'rn1_only' OR m.bucket = 'shared')
            AND f.trader_wallet_id = ${rn1WalletId}
        ), 0)
        + COALESCE(SUM(f.size_usdc::numeric) FILTER (
          WHERE (m.bucket = 'swisstony_only' OR m.bucket = 'shared')
            AND f.trader_wallet_id = ${swisstonyWalletId}
        ), 0) AS fill_volume_usdc,
        COALESCE(SUM(f.size_usdc::numeric) FILTER (
          WHERE (m.bucket = 'rn1_only' OR m.bucket = 'shared')
            AND f.trader_wallet_id = ${rn1WalletId}
        ), 0) AS rn1_fill_volume_usdc,
        COALESCE(SUM(f.size_usdc::numeric) FILTER (
          WHERE (m.bucket = 'swisstony_only' OR m.bucket = 'shared')
            AND f.trader_wallet_id = ${swisstonyWalletId}
        ), 0) AS swisstony_fill_volume_usdc
      FROM markets m
      JOIN poly_trader_fills f ON f.condition_id = m.condition_id
        AND f.trader_wallet_id IN (${rn1WalletId}, ${swisstonyWalletId})
        AND f.observed_at >= ${windowStartIso}::timestamptz
      GROUP BY m.bucket
    )
    SELECT
      m.bucket,
      COUNT(*) AS market_count,
      COALESCE(SUM(m.position_count), 0) AS position_count,
      COALESCE(SUM(m.current_value_usdc), 0) AS current_value_usdc,
      COALESCE(MAX(v.fill_volume_usdc), 0) AS fill_volume_usdc,
      COUNT(*) FILTER (WHERE m.rn1_active) AS rn1_market_count,
      COALESCE(SUM(m.rn1_position_count), 0) AS rn1_position_count,
      COALESCE(SUM(m.rn1_current_value_usdc), 0) AS rn1_current_value_usdc,
      COALESCE(MAX(v.rn1_fill_volume_usdc), 0) AS rn1_fill_volume_usdc,
      COUNT(*) FILTER (WHERE m.swisstony_active) AS swisstony_market_count,
      COALESCE(SUM(m.swisstony_position_count), 0) AS swisstony_position_count,
      COALESCE(SUM(m.swisstony_current_value_usdc), 0) AS swisstony_current_value_usdc,
      COALESCE(MAX(v.swisstony_fill_volume_usdc), 0) AS swisstony_fill_volume_usdc
    FROM markets m
    LEFT JOIN volumes v ON v.bucket = m.bucket
    GROUP BY m.bucket
  `);
  return listFromExecute(rows);
}

export type TradeSummaryOracleRow = Record<string, unknown>;

export type WalletTokenPnlOracleRow = {
  condition_id: string | null;
  token_id: string | null;
  total_buy_notional: string | number | null;
  realized_cash: string | number | null;
  net_shares: string | number | null;
  current_value_usdc: string | number | null;
  market_outcome: string | null;
};

/**
 * Legacy `realized-pnl-service.readWalletTokenPnlMap` SQL — full-history
 * SUM/FILTER over every fill the wallet ever had, GROUP BY
 * `(condition_id, token_id)`, with the current-mark CTE + outcomes join.
 * Preserved verbatim from the pre-wave-C reader.
 */
export async function readWalletTokenPnlOracle(
  db: Db,
  walletAddress: string
): Promise<WalletTokenPnlOracleRow[]> {
  const rows = await db.execute(sql`
    WITH fills_agg AS (
      SELECT
        f.condition_id,
        f.token_id,
        COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'BUY'), 0)::numeric
          AS total_buy_notional,
        COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'SELL'), 0)::numeric
          AS realized_cash,
        (
          COALESCE(SUM(f.shares) FILTER (WHERE f.side = 'BUY'), 0)
          - COALESCE(SUM(f.shares) FILTER (WHERE f.side = 'SELL'), 0)
        )::numeric AS net_shares
      FROM poly_trader_fills f
      JOIN poly_trader_wallets w ON w.id = f.trader_wallet_id
      WHERE w.wallet_address = lower(${walletAddress})
      GROUP BY f.condition_id, f.token_id
    ),
    current_mark AS (
      SELECT
        p.condition_id,
        p.token_id,
        COALESCE(SUM(p.current_value_usdc::numeric), 0) AS current_value_usdc
      FROM poly_trader_current_positions p
      JOIN poly_trader_wallets w ON w.id = p.trader_wallet_id
      WHERE w.wallet_address = lower(${walletAddress})
        AND ${liveCurrentPositionSql("p")}
      GROUP BY p.condition_id, p.token_id
    )
    SELECT
      fa.condition_id,
      fa.token_id,
      fa.total_buy_notional,
      fa.realized_cash,
      fa.net_shares,
      COALESCE(cm.current_value_usdc, 0) AS current_value_usdc,
      pmo.outcome AS market_outcome
    FROM fills_agg fa
    LEFT JOIN current_mark cm
      ON cm.condition_id = fa.condition_id
     AND cm.token_id = fa.token_id
    LEFT JOIN poly_market_outcomes pmo
      ON pmo.condition_id = fa.condition_id
     AND pmo.token_id = fa.token_id
  `);
  return listFromExecute(rows) as unknown as WalletTokenPnlOracleRow[];
}

export type MarketFillRollupOracleRow = {
  wallet_address: string | null;
  condition_id: string | null;
  token_id: string | null;
  total_buy_notional: string | number | null;
  realized_cash: string | number | null;
  net_shares: string | number | null;
  market_outcome: string | null;
};

/**
 * Legacy `market-exposure-service.readFillRollups` SQL — our wallet ∪ target
 * wallets aggregated per `(wallet, condition, token)` over raw
 * `poly_trader_fills` with a `condition_id IN (...)` filter. Preserved
 * verbatim from the pre-wave-C reader (caller lowercased the addresses).
 */
export async function readMarketFillRollupsOracle(
  db: Db,
  conditions: readonly string[],
  walletAddresses: readonly string[]
): Promise<MarketFillRollupOracleRow[]> {
  if (conditions.length === 0 || walletAddresses.length === 0) return [];
  const conditionList = sql.join(
    conditions.map((c) => sql`${c}`),
    sql`, `
  );
  const walletList = sql.join(
    walletAddresses.map((w) => sql`${w.toLowerCase()}`),
    sql`, `
  );
  const rows = await db.execute(sql`
    SELECT
      lower(w.wallet_address) AS wallet_address,
      f.condition_id,
      f.token_id,
      COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'BUY'), 0)::numeric
        AS total_buy_notional,
      COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'SELL'), 0)::numeric
        AS realized_cash,
      (
        COALESCE(SUM(f.shares) FILTER (WHERE f.side = 'BUY'), 0)
        - COALESCE(SUM(f.shares) FILTER (WHERE f.side = 'SELL'), 0)
      )::numeric AS net_shares,
      pmo.outcome AS market_outcome
    FROM poly_trader_fills f
    JOIN poly_trader_wallets w ON w.id = f.trader_wallet_id
    LEFT JOIN poly_market_outcomes pmo
      ON pmo.condition_id = f.condition_id
     AND pmo.token_id = f.token_id
    WHERE f.condition_id IN (${conditionList})
      AND w.wallet_address IN (${walletList})
    GROUP BY lower(w.wallet_address), f.condition_id, f.token_id, pmo.outcome
  `);
  return listFromExecute(rows) as unknown as MarketFillRollupOracleRow[];
}

/** Legacy trader-comparison summary — windowed LEFT JOIN aggregate over fills. */
export async function readTradeSummaryOracle(
  db: Db,
  address: string,
  windowStartIso: string
): Promise<TradeSummaryOracleRow | null> {
  const rows = await db.execute(sql`
    SELECT
      w.id,
      w.label,
      w.kind,
      w.first_observed_at,
      c.last_success_at,
      c.status,
      COALESCE(COUNT(f.id), 0) AS trade_count,
      COALESCE(COUNT(f.id) FILTER (WHERE f.side = 'BUY'), 0) AS buy_count,
      COALESCE(COUNT(f.id) FILTER (WHERE f.side = 'SELL'), 0) AS sell_count,
      COALESCE(SUM(f.size_usdc::numeric), 0) AS notional_usdc,
      COALESCE(SUM(f.size_usdc::numeric) FILTER (WHERE f.side = 'BUY'), 0) AS buy_usdc,
      COALESCE(SUM(f.size_usdc::numeric) FILTER (WHERE f.side = 'SELL'), 0) AS sell_usdc,
      COALESCE(COUNT(DISTINCT f.condition_id), 0) AS market_count
    FROM poly_trader_wallets w
    LEFT JOIN poly_trader_ingestion_cursors c
      ON c.trader_wallet_id = w.id
      AND c.source = 'data-api-trades'
    LEFT JOIN poly_trader_fills f
      ON f.trader_wallet_id = w.id
      AND f.observed_at >= ${windowStartIso}::timestamptz
    WHERE w.wallet_address = ${address}
    GROUP BY w.id, w.label, w.kind, w.first_observed_at, c.last_success_at, c.status
    LIMIT 1
  `);
  return listFromExecute(rows)[0] ?? null;
}
