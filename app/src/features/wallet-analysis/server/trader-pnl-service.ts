// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/trader-pnl-service`
 * Purpose: The Research page's Trader P/L overlay read — saved Polymarket-native P/L series
 *   for up to three wallets from `poly_trader_user_pnl_points`, in ONE bounded SQL statement.
 * Scope: Read-only feature service. Caller injects the DB and normalized wallets; no auth/HTTP.
 * Invariants:
 *   - PAGE_LOAD_DB_ONLY: reads the saved user-pnl read model; never calls Polymarket on render
 *     (the observation tick is the only `/v2/user-pnl` caller).
 *   - ONE_STATEMENT_ONE_CONNECTION: all requested wallets resolve in a single indexed statement
 *     inside one short transaction (one pooled connection). The previous path ran two
 *     transactions per wallet in parallel (6 connections for 3 wallets) next to a fill-scanning
 *     aggregate, which exhausted the 4-connection service pool (bug.5064 / bug.5065).
 *   - SERVER_DOWNSAMPLED: points are bucketed in SQL to at most `TRADER_PNL_MAX_POINTS` per
 *     wallet (last point per bucket, ts snapped to the bucket start so wallets share an x-axis).
 *     ALL = full stored history, bucket width derived from its span.
 *   - NEVER_SILENTLY_DROP: every requested wallet is returned; a wallet that is not observed,
 *     has no points, or has stale points carries a per-wallet warning. Stale points are still
 *     served (an overlay of slightly old P/L beats an empty chart) alongside the warning.
 *   - INTERVAL_MAP_SHARED: fidelity per interval is `readFidelityForInterval` and the window
 *     start is `portfolioWindowStart` — the same mapping the wallet P/L card uses.
 * Side-effects: one DB read transaction.
 * Links: packages/poly-node-contracts/src/poly.research-trader-pnl.v1.contract.ts, work/items/bug.5065
 * @public
 */

import {
  type PolyResearchTraderPnlResponse,
  type PolyResearchTraderPnlTrader,
  type PolyResearchTraderPnlWarning,
  type PolyWalletOverviewInterval,
  TRADER_PNL_MAX_POINTS,
} from "@cogni/poly-node-contracts";
import { type SQL, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { withResearchReadTimeout } from "./fill-rollup-service";
import { portfolioWindowStart } from "./portfolio-window";
import {
  PNL_FRESHNESS_MS,
  readFidelityForInterval,
} from "./trading-wallet-overview-service";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

export type TraderPnlInput = {
  address: string;
  label?: string | undefined;
};

/** Statement ceiling for the overlay read. It is an indexed read of <few thousand rows. */
export const TRADER_PNL_READ_TIMEOUT_MS = 3_000;

export const TRADER_PNL_NOT_OBSERVED_WARNING = "wallet_not_observed";
export const TRADER_PNL_NO_HISTORY_WARNING = "pnl_history_not_recorded";
export const TRADER_PNL_STALE_WARNING = "pnl_history_stale";

/** Minimum bucket width per stored fidelity (the native point spacing). */
const MIN_BUCKET_SECONDS = { "1h": 3_600, "1d": 86_400 } as const;

export type TraderPnlReadPlan = {
  fidelity: "1h" | "1d";
  /** ISO lower bound, or null for ALL / unparseable clock (no bound). */
  windowStartIso: string | null;
  minBucketSeconds: number;
};

/** Pure per-interval mapping: which stored series, which window, which native spacing. */
export function planTraderPnlRead(
  interval: PolyWalletOverviewInterval,
  capturedAtIso: string
): TraderPnlReadPlan {
  const fidelity = readFidelityForInterval(interval);
  return {
    fidelity,
    windowStartIso:
      portfolioWindowStart(interval, capturedAtIso)?.toISOString() ?? null,
    minBucketSeconds: MIN_BUCKET_SECONDS[fidelity],
  };
}

/** One SQL result row: a requested+observed wallet, with at most one downsampled point. */
export type TraderPnlSqlRow = {
  wallet_address: string;
  label: string;
  observed_at: Date | string | null;
  bucket_seconds: string | number | null;
  bucket: string | number | null;
  pnl_usdc: string | number | null;
};

/**
 * Read the overlay series for `wallets` (max 3) in one statement. Order and length of
 * the returned `traders` follow the input; nothing is dropped.
 */
export async function getTraderPnl(
  db: Db,
  wallets: readonly TraderPnlInput[],
  interval: PolyWalletOverviewInterval,
  opts: { now?: Date } = {}
): Promise<PolyResearchTraderPnlResponse> {
  const inputs = wallets.slice(0, 3);
  const capturedAt = (opts.now ?? new Date()).toISOString();
  const plan = planTraderPnlRead(interval, capturedAt);
  const addresses = [...new Set(inputs.map((w) => w.address.toLowerCase()))];

  const rows = await withResearchReadTimeout(
    db,
    async (tx) =>
      rowsOf<TraderPnlSqlRow>(
        await tx.execute(buildTraderPnlStatement(addresses, plan, capturedAt))
      ),
    TRADER_PNL_READ_TIMEOUT_MS
  );
  return assembleTraderPnl(interval, inputs, rows, capturedAt);
}

/**
 * ONE statement: resolve the observed wallet ids, read their `(fidelity, ts >= window)`
 * points through the PK index `(trader_wallet_id, fidelity, ts)` (LATERAL pins the plan to
 * one index range scan per wallet instead of a table scan + hash join), derive one global bucket
 * width from the widest span (so every series shares an x-axis and stays <= max points),
 * keep the last point per (wallet, bucket), and left-join so a wallet with no points still
 * yields a row. Returns <= wallets * TRADER_PNL_MAX_POINTS rows.
 */
export function buildTraderPnlStatement(
  addresses: readonly string[],
  plan: TraderPnlReadPlan,
  capturedAtIso: string
): SQL {
  const addressList = sql.join(
    addresses.map((a) => sql`${a}`),
    sql`, `
  );
  const windowBound = plan.windowStartIso
    ? sql`AND p.ts >= ${plan.windowStartIso}::timestamptz`
    : sql``;
  return sql`
    WITH w AS (
      SELECT id, wallet_address, label
      FROM poly_trader_wallets
      WHERE wallet_address IN (${addressList})
        AND active_for_research = true
        AND disabled_at IS NULL
    ),
    pts AS (
      SELECT w.wallet_address, p.ts, p.pnl_usdc, p.observed_at
      FROM w
      CROSS JOIN LATERAL (
        SELECT p.ts, p.pnl_usdc, p.observed_at
        FROM poly_trader_user_pnl_points p
        WHERE p.trader_wallet_id = w.id
          AND p.fidelity = ${plan.fidelity}
          ${windowBound}
      ) p
    ),
    meta AS (
      SELECT wallet_address, MAX(observed_at) AS observed_at
      FROM pts
      GROUP BY wallet_address
    ),
    bk AS (
      SELECT GREATEST(
        ${plan.minBucketSeconds}::bigint,
        (CEIL(
          COALESCE(EXTRACT(EPOCH FROM (${capturedAtIso}::timestamptz - MIN(ts))), 0)::numeric
            / ${TRADER_PNL_MAX_POINTS}::numeric
            / ${plan.minBucketSeconds}::numeric
        ) * ${plan.minBucketSeconds}::numeric)::bigint
      ) AS seconds
      FROM pts
    ),
    ranked AS (
      SELECT DISTINCT ON (pts.wallet_address, b.bucket)
        pts.wallet_address, b.bucket, pts.pnl_usdc
      FROM pts
      CROSS JOIN bk
      CROSS JOIN LATERAL (
        SELECT FLOOR(EXTRACT(EPOCH FROM pts.ts) / bk.seconds)::bigint AS bucket
      ) b
      ORDER BY pts.wallet_address, b.bucket, pts.ts DESC
    )
    SELECT
      w.wallet_address,
      w.label,
      m.observed_at,
      (SELECT seconds FROM bk) AS bucket_seconds,
      r.bucket,
      r.pnl_usdc
    FROM w
    LEFT JOIN meta m ON m.wallet_address = w.wallet_address
    LEFT JOIN ranked r ON r.wallet_address = w.wallet_address
    ORDER BY w.wallet_address, r.bucket
  `;
}

/**
 * Pure assembly over SQL rows. One trader per distinct requested wallet, in request order
 * (labels re-stamped positionally; the stored label, else the short address, is the fallback).
 * Unobserved / empty / stale wallets keep their slot and gain a warning.
 */
export function assembleTraderPnl(
  interval: PolyWalletOverviewInterval,
  inputs: readonly TraderPnlInput[],
  rows: readonly TraderPnlSqlRow[],
  capturedAtIso: string
): PolyResearchTraderPnlResponse {
  const byWallet = new Map<string, TraderPnlSqlRow[]>();
  for (const row of rows) {
    const key = row.wallet_address.toLowerCase();
    const list = byWallet.get(key);
    if (list) list.push(row);
    else byWallet.set(key, [row]);
  }
  const capturedMs = new Date(capturedAtIso).getTime();

  const traders: PolyResearchTraderPnlTrader[] = [];
  const warnings: PolyResearchTraderPnlWarning[] = [];
  const emitted = new Set<string>();
  for (const input of inputs) {
    const address = input.address.toLowerCase() as `0x${string}`;
    if (emitted.has(address)) continue;
    emitted.add(address);
    const walletRows = byWallet.get(address);
    const label =
      input.label?.trim() || walletRows?.[0]?.label || shortAddress(address);

    if (!walletRows) {
      traders.push(emptyTrader(address, label, interval));
      warnings.push({
        wallet: address,
        code: TRADER_PNL_NOT_OBSERVED_WARNING,
        message: `No saved P/L series: ${address} is not an observed research wallet.`,
      });
      continue;
    }

    const history = walletRows.flatMap((row) => {
      if (row.bucket === null || row.pnl_usdc === null) return [];
      const bucketSeconds = Number(row.bucket_seconds);
      const ms = Number(row.bucket) * bucketSeconds * 1_000;
      if (!Number.isFinite(ms)) return [];
      return [{ ts: new Date(ms).toISOString(), pnl: roundUsd(Number(row.pnl_usdc)) }];
    });
    if (history.length === 0) {
      traders.push(emptyTrader(address, label, interval));
      warnings.push({
        wallet: address,
        code: TRADER_PNL_NO_HISTORY_WARNING,
        message: `No saved P/L points for ${address} in the selected interval.`,
      });
      continue;
    }

    const observedAt = toMs(walletRows[0]?.observed_at);
    if (
      observedAt !== null &&
      Number.isFinite(capturedMs) &&
      capturedMs - observedAt > PNL_FRESHNESS_MS
    ) {
      warnings.push({
        wallet: address,
        code: TRADER_PNL_STALE_WARNING,
        message: `Saved P/L for ${address} is older than the ${PNL_FRESHNESS_MS / 60_000}-minute freshness window (last observed ${new Date(observedAt).toISOString()}).`,
      });
    }
    traders.push({
      address,
      label,
      interval,
      pnl: { usdc: windowedDelta(history), history },
    });
  }
  return { interval, capturedAt: capturedAtIso, traders, warnings };
}

function emptyTrader(
  address: `0x${string}`,
  label: string,
  interval: PolyWalletOverviewInterval
): PolyResearchTraderPnlTrader {
  return { address, label, interval, pnl: { usdc: null, history: [] } };
}

function windowedDelta(
  history: readonly { ts: string; pnl: number }[]
): number | null {
  const first = history[0];
  const last = history.at(-1);
  if (history.length < 2 || !first || !last) return null;
  return Number((last.pnl - first.pnl).toFixed(8));
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result)
    ? (result as T[])
    : (((result as { rows?: T[] }).rows ?? []) as T[]);
}

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const ms = (value instanceof Date ? value : new Date(value)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
