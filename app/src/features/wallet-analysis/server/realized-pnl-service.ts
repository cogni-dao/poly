// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/realized-pnl-service`
 * Purpose: Canonical per-`(conditionId, tokenId)` realized P/L for one
 *   wallet, fed by `poly_trader_fills` + `poly_market_outcomes` +
 *   `poly_trader_current_positions`. Single source of truth for the
 *   dashboard's positions list, markets aggregator, and any future
 *   historical-analysis surface.
 * Scope: Read-only DB aggregation + math composition. No upstream API
 *   calls; no writers. Math itself lives in `market-return-math`.
 * Invariants:
 *   - SINGLE_BOUNDED_QUERY: one SQL aggregation per call, GROUP BY
 *     `(condition_id, token_id)`. Never hydrates raw fills row-by-row
 *     into V8 (data-research skill — bug.5012 class avoidance).
 *   - OUTCOME_AUTHORITATIVE: when `poly_market_outcomes` classifies the
 *     token as winner/loser, `computeRealizedPnl` derives realized P/L
 *     from outcome alone — `currentMarkValue` is only consulted for
 *     unresolved markets. This sidesteps Polymarket's stale-echo race
 *     (Data API rows continue to mid-price after CTF burn) and yields
 *     the deterministic redemption payout for closed winners.
 *   - PERSISTENCE_READY_SHAPE: the returned per-leg fields
 *     (`totalBuyNotionalUsdc`, `realizedCashUsdc`, `netShares`,
 *     `redemptionProceedsUsdc`, `marketOutcome`) are the exact columns
 *     a future `poly_wallet_token_pnl` snapshot table would store;
 *     readers can transparently switch from this on-read computation
 *     to a pre-materialized table without changing the contract.
 * Side-effects: DB read only.
 * Links: work/items/bug.* (closed-position P/L), docs/spec/poly-copy-trade-execution.md
 * @public
 */

import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";

import { liveCurrentPositionSql } from "./current-position-staleness";
import { computeRealizedPnl, type MarketOutcome } from "./market-return-math";

type Db = {
  execute(query: SQL): Promise<unknown>;
};

export type WalletTokenPnl = {
  conditionId: string;
  tokenId: string;
  totalBuyNotionalUsdc: number;
  realizedCashUsdc: number;
  netShares: number;
  currentMarkUsdc: number;
  marketOutcome: MarketOutcome;
  redemptionProceedsUsdc: number;
  pnlUsd: number;
  pnlPct: number | null;
};

type Row = {
  condition_id: string | null;
  token_id: string | null;
  total_buy_notional: string | number | null;
  realized_cash: string | number | null;
  net_shares: string | number | null;
  current_value_usdc: string | number | null;
  market_outcome: string | null;
};

/**
 * Build a `(conditionId, tokenId) → WalletTokenPnl` index for one wallet.
 * Caller is expected to look up by `tokenPnlKey(conditionId, tokenId)`.
 *
 * One row is emitted per token the wallet has ever filled. Tokens with no
 * fill history are absent from the map — callers must fall through to the
 * `currentValue − costBasis` mark-to-market path on miss.
 */
export async function readWalletTokenPnlMap(params: {
  db: Db;
  walletAddress: string;
}): Promise<Map<string, WalletTokenPnl>> {
  const rows = normalizeRows<Row>(
    await params.db.execute(sql`
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
        WHERE lower(w.wallet_address) = lower(${params.walletAddress})
        GROUP BY f.condition_id, f.token_id
      ),
      current_mark AS (
        SELECT
          p.condition_id,
          p.token_id,
          COALESCE(SUM(p.current_value_usdc::numeric), 0) AS current_value_usdc
        FROM poly_trader_current_positions p
        JOIN poly_trader_wallets w ON w.id = p.trader_wallet_id
        WHERE lower(w.wallet_address) = lower(${params.walletAddress})
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
        ON lower(pmo.condition_id) = lower(fa.condition_id)
       AND pmo.token_id = fa.token_id
    `)
  );

  const map = new Map<string, WalletTokenPnl>();
  for (const row of rows) {
    if (row.condition_id === null || row.token_id === null) continue;
    const totalBuyNotional = toNumber(row.total_buy_notional);
    // No BUY history → no realized-PnL signal; let the caller fall back to
    // `currentValue − costBasis`. In production `fills_agg` is built from
    // fills rows so this branch can't reach an empty buy notional unless
    // the wallet has only ever sold (impossible without prior buy).
    if (totalBuyNotional <= 0) continue;
    const realizedCash = toNumber(row.realized_cash);
    const netShares = toNumber(row.net_shares);
    const currentMarkUsdc = toNumber(row.current_value_usdc);
    const marketOutcome = normalizeOutcome(row.market_outcome);
    const { pnlUsd, pnlPct, redemptionProceeds } = computeRealizedPnl({
      totalBuyNotional,
      realizedCash,
      currentMarkValue: currentMarkUsdc,
      netShares,
      marketOutcome,
    });
    map.set(tokenPnlKey(row.condition_id, row.token_id), {
      conditionId: row.condition_id,
      tokenId: row.token_id,
      totalBuyNotionalUsdc: totalBuyNotional,
      realizedCashUsdc: realizedCash,
      netShares,
      currentMarkUsdc,
      marketOutcome,
      redemptionProceedsUsdc: redemptionProceeds,
      pnlUsd,
      pnlPct,
    });
  }
  return map;
}

export function tokenPnlKey(conditionId: string, tokenId: string): string {
  return `${conditionId.toLowerCase()}:${tokenId}`;
}

/**
 * Overlay canonical fills + outcomes realized P/L onto already-coalesced
 * per-(condition, token) positions. After this pass, closed rows surface
 * the correct redemption credit instead of the unrealized MTM left over
 * from upstream read models. Caller is expected to fetch the map via
 * `readWalletTokenPnlMap` once per request.
 *
 * `pnlPct` here is expressed in percentage points (e.g. `60` for +60%),
 * matching `WalletExecutionPosition.pnlPct`'s contract — the underlying
 * `pnlPct` field on `WalletTokenPnl` is fractional and multiplied by 100.
 */
export function applyRealizedPnl(
  positions: readonly WalletExecutionPosition[],
  realizedPnlMap: ReadonlyMap<string, WalletTokenPnl>
): WalletExecutionPosition[] {
  return positions.map((position) => {
    const entry = realizedPnlMap.get(
      tokenPnlKey(position.conditionId, position.asset)
    );
    if (entry === undefined) return position;
    const pnlPct =
      entry.pnlPct !== null
        ? roundToCents(entry.pnlPct * 100)
        : position.pnlPct;
    return {
      ...position,
      pnlUsd: entry.pnlUsd,
      pnlPct,
    };
  });
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeOutcome(value: string | null): MarketOutcome {
  if (value === "winner" || value === "loser" || value === "unknown") {
    return value;
  }
  return null;
}

function normalizeRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}
