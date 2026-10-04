// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/copy-trade-pnl-service`
 * Purpose: Per-tenant mirror-execution rollup from `poly_copy_trade_fills`, grouped by (target_id, market_id).
 *   Powers the trust-twin diff script that compares preview paper PnL vs PROD
 *   live PnL on the same target wallet config.
 * Scope: Read-only service; does not fetch upstream Polymarket, write rows, or hydrate raw fills into V8.
 *   Caller injects DB (service-DB so callers can pass any billing_account_id —
 *   RLS is bypassed by design here).
 * Invariants: SQL_AGGREGATION_ONLY — one GROUP BY, no V8 reduce over raw rows;
 *   REALIZED_USES_FILLED_SIZE_USDC — sum of `attributes->>'filled_size_usdc'` for
 *   {filled,partial} (v0 paper-sidecar stamps `= intent.size_usdc` on full fills);
 *   HAS_OPEN_POSITION_MATCHES_RESTING_PREDICATE — mirrors the executor's
 *   DEDUPE_AT_DB partial-unique predicate so the boolean lines up with what the
 *   placement path treats as "an active resting slot."
 * Side-effects: IO (DB reads only).
 * Links: docs/spec/poly-copy-trade-execution.md · work/projects/proj.poly-paper-trading.md
 * @public
 */

import { polyCopyTradeFills } from "@cogni/poly-db-schema/copy-trade";
import type {
  PolyResearchCopyTradePnlMode,
  PolyResearchCopyTradePnlResponse,
} from "@cogni/poly-node-contracts";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

type MarketRowRaw = {
  market_id: string;
  target_id: string;
  target_wallet: string | null;
  fills_count: string;
  filled_count: string;
  open_count: string;
  pending_count: string;
  canceled_count: string;
  error_count: string;
  buy_count: string;
  sell_count: string;
  intent_usdc: string | null;
  realized_size_usdc: string | null;
  has_open_position: boolean;
  position_lifecycle: string | null;
  // pg driver returns timestamptz as ISO string (or Date in some configs);
  // accept both shapes and normalize in `toIso`.
  first_fill_at: string | Date | null;
  last_fill_at: string | Date | null;
};

const toNum = (v: string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toIso = (d: string | Date | null | undefined): string | null => {
  if (d === null || d === undefined) return null;
  if (typeof d === "string") return d;
  return d.toISOString();
};

export async function getCopyTradePnlForTenant(
  db: Db,
  billingAccountId: string,
  mode: PolyResearchCopyTradePnlMode,
  window?: { since?: string; until?: string }
): Promise<PolyResearchCopyTradePnlResponse> {
  const modeFilter =
    mode === "all" ? sql`TRUE` : eq(polyCopyTradeFills.mode, mode);
  const sinceFilter = window?.since
    ? gte(polyCopyTradeFills.observedAt, new Date(window.since))
    : sql`TRUE`;
  const untilFilter = window?.until
    ? lt(polyCopyTradeFills.observedAt, new Date(window.until))
    : sql`TRUE`;

  // Single grouped aggregate. One row per (target, market). Returns at most
  // markets_count rows; for any single tenant this is bounded by their
  // active+historical market set, not by fill count.
  // NB: `poly_copy_trade_fills.target_id` is uuidv5(target_wallet) — does NOT
  // join to `poly_copy_trade_targets.id` (uuidv4). target_wallet comes from
  // `attributes->>'target_wallet'` (same path as orders route).
  const rows = (await db.execute(sql`
    SELECT
      ${polyCopyTradeFills.marketId} AS market_id,
      ${polyCopyTradeFills.targetId} AS target_id,
      MAX(${polyCopyTradeFills.attributes}->>'target_wallet') AS target_wallet,
      COUNT(*)::int AS fills_count,
      COUNT(*) FILTER (WHERE ${polyCopyTradeFills.status} = 'filled')::int AS filled_count,
      COUNT(*) FILTER (WHERE ${polyCopyTradeFills.status} = 'open')::int AS open_count,
      COUNT(*) FILTER (WHERE ${polyCopyTradeFills.status} = 'pending')::int AS pending_count,
      COUNT(*) FILTER (WHERE ${polyCopyTradeFills.status} IN ('canceled','partial'))::int AS canceled_count,
      COUNT(*) FILTER (WHERE ${polyCopyTradeFills.status} = 'error')::int AS error_count,
      COUNT(*) FILTER (WHERE ${polyCopyTradeFills.attributes}->>'side' = 'BUY')::int AS buy_count,
      COUNT(*) FILTER (WHERE ${polyCopyTradeFills.attributes}->>'side' = 'SELL')::int AS sell_count,
      COALESCE(SUM(
        CASE WHEN ${polyCopyTradeFills.attributes}->>'size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
             THEN (${polyCopyTradeFills.attributes}->>'size_usdc')::numeric
             ELSE 0 END
      ), 0)::text AS intent_usdc,
      COALESCE(SUM(
        CASE
          WHEN ${polyCopyTradeFills.status} IN ('filled','partial')
            AND ${polyCopyTradeFills.attributes}->>'filled_size_usdc' ~ '^[0-9]+(\\.[0-9]+)?$'
          THEN (${polyCopyTradeFills.attributes}->>'filled_size_usdc')::numeric
          ELSE 0
        END
      ), 0)::text AS realized_size_usdc,
      BOOL_OR(
        (${polyCopyTradeFills.positionLifecycle} IS NULL
         OR ${polyCopyTradeFills.positionLifecycle} IN ('unresolved','open','closing'))
        AND ${polyCopyTradeFills.attributes}->>'closed_at' IS NULL
        AND ${polyCopyTradeFills.status} IN ('pending','open','partial','filled')
      ) AS has_open_position,
      MAX(${polyCopyTradeFills.positionLifecycle}) AS position_lifecycle,
      MIN(${polyCopyTradeFills.observedAt}) AS first_fill_at,
      MAX(${polyCopyTradeFills.observedAt}) AS last_fill_at
    FROM ${polyCopyTradeFills}
    WHERE ${and(
      eq(polyCopyTradeFills.billingAccountId, billingAccountId),
      modeFilter,
      sinceFilter,
      untilFilter
    )}
    GROUP BY ${polyCopyTradeFills.marketId},
             ${polyCopyTradeFills.targetId}
    ORDER BY MAX(${polyCopyTradeFills.observedAt}) DESC NULLS LAST
  `)) as unknown as { rows: MarketRowRaw[] } | MarketRowRaw[];

  // node-postgres returns { rows: [...] }; postgres-js returns the array.
  const list: MarketRowRaw[] = Array.isArray(rows) ? rows : (rows.rows ?? []);

  const markets = list.map((r) => ({
    market_id: r.market_id,
    target_id: r.target_id,
    target_wallet: r.target_wallet,
    fills_count: Number(r.fills_count) || 0,
    filled_count: Number(r.filled_count) || 0,
    open_count: Number(r.open_count) || 0,
    pending_count: Number(r.pending_count) || 0,
    canceled_count: Number(r.canceled_count) || 0,
    error_count: Number(r.error_count) || 0,
    buy_count: Number(r.buy_count) || 0,
    sell_count: Number(r.sell_count) || 0,
    intent_usdc: toNum(r.intent_usdc),
    realized_size_usdc: toNum(r.realized_size_usdc),
    has_open_position: Boolean(r.has_open_position),
    position_lifecycle: r.position_lifecycle,
    first_fill_at: toIso(r.first_fill_at),
    last_fill_at: toIso(r.last_fill_at),
  }));

  const summary = {
    fills_count: markets.reduce((s, m) => s + m.fills_count, 0),
    filled_count: markets.reduce((s, m) => s + m.filled_count, 0),
    open_count: markets.reduce((s, m) => s + m.open_count, 0),
    pending_count: markets.reduce((s, m) => s + m.pending_count, 0),
    canceled_count: markets.reduce((s, m) => s + m.canceled_count, 0),
    error_count: markets.reduce((s, m) => s + m.error_count, 0),
    markets_count: markets.length,
    markets_with_open_position: markets.filter((m) => m.has_open_position)
      .length,
    total_intent_usdc: markets.reduce((s, m) => s + m.intent_usdc, 0),
    total_realized_size_usdc: markets.reduce(
      (s, m) => s + m.realized_size_usdc,
      0
    ),
    first_fill_at: markets.reduce<string | null>((acc, m) => {
      if (!m.first_fill_at) return acc;
      if (!acc || m.first_fill_at < acc) return m.first_fill_at;
      return acc;
    }, null),
    last_fill_at: markets.reduce<string | null>((acc, m) => {
      if (!m.last_fill_at) return acc;
      if (!acc || m.last_fill_at > acc) return m.last_fill_at;
      return acc;
    }, null),
  };

  return {
    billing_account_id: billingAccountId,
    mode,
    since: window?.since ?? null,
    until: window?.until ?? null,
    captured_at: new Date().toISOString(),
    summary,
    markets,
  };
}
