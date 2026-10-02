// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/trading-wallet-overview-service`
 * Purpose: DB-backed read of saved Polymarket user-pnl points + writer that
 *          ingests live `/user-pnl` into the same table from the observation tick.
 * Scope: Read + write + retention helpers. Reader is page-load safe (no outbound
 *        HTTP). Writer runs in poll/refresh jobs only.
 * Invariants:
 *   - PNL_NOT_NAV: the returned series is Polymarket P/L, not reconstructed wallet balance.
 *   - EMPTY_IS_HONEST: zero stored points returns `[]` — readers do not fall back to live HTTP.
 *   - MISSING_IS_NOT_EMPTY: the structured reader distinguishes an absent
 *     observer wallet from an observed wallet with no saved P/L points.
 *   - PAGE_LOAD_DB_ONLY: `getTradingWalletPnlHistory` is a pure DB read; only `fetchAndPersist*` calls `/user-pnl`.
 *   - INTERVAL_DERIVED_FROM_TIMESERIES: rows are stored at two fidelities; the reader picks the densest fidelity covering the requested window.
 *   - FIDELITY_PLAN: writer ingests `1h@1w` and `1d@all`. Reader maps `1D`/`1W` → `1h` rows and `1M`/`1Y`/`YTD`/`ALL` → `1d` rows.
 *   - DEDUPE_BY_TS: PK `(trader_wallet_id, fidelity, ts)`; re-poll upserts pnl + observed_at.
 *   - RETENTION_BOUNDED: `1h` rows >35d pruned by the same job; `1d` kept indefinitely.
 * Side-effects:
 *   - Reader: DB read.
 *   - Writer: IO (Polymarket user-pnl API) + DB upsert.
 * Links: nodes/poly/packages/db-schema/src/trader-activity.ts, work/items/task.5012
 * @public
 */

import {
  polyTraderUserPnlPoints,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import {
  PolymarketUserPnlClient,
  type PolymarketUserPnlPoint,
  type UserPnlOutboundLogger,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type {
  PolyWalletOverviewInterval,
  PolyWalletOverviewPnlPoint,
} from "@cogni/poly-node-contracts";
import { and, asc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dedupeByKey } from "./observation-helpers";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

type Fidelity = "1h" | "1d";
const HOUR_FIDELITY: Fidelity = "1h";
const DAY_FIDELITY: Fidelity = "1d";

/** `1h` rows older than this are pruned by the writer's tick. */
const HOUR_FIDELITY_RETENTION_DAYS = 35;

let userPnlClient: PolymarketUserPnlClient | undefined;

function getUserPnlClient(): PolymarketUserPnlClient {
  if (!userPnlClient) userPnlClient = new PolymarketUserPnlClient();
  return userPnlClient;
}

export function __setTradingWalletOverviewUserPnlClientForTests(
  client: PolymarketUserPnlClient | undefined
): void {
  userPnlClient = client;
}

export type TradingWalletPnlHistoryStatus =
  | "available"
  | "no_history"
  | "wallet_missing";

export interface TradingWalletPnlHistoryRead {
  points: PolyWalletOverviewPnlPoint[];
  status: TradingWalletPnlHistoryStatus;
}

/**
 * DB-backed page-load read with explicit availability state.
 *
 * `wallet_missing` means the observer has no active identity row for this
 * address and an empty series must not be presented as a real zero history.
 * `no_history` means the wallet is enrolled but no persisted points exist for
 * the requested fidelity/window. Enrollment alone is not an ingestion-success
 * marker, so this state makes no stronger claim. `available` includes an
 * all-zero series: a persisted zero-valued point is data.
 */
export async function getTradingWalletPnlHistoryRead(input: {
  db: Db;
  address: `0x${string}`;
  interval: PolyWalletOverviewInterval;
  capturedAt?: string;
}): Promise<TradingWalletPnlHistoryRead> {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const fidelity = readFidelityForInterval(input.interval);
  const wallet = await input.db
    .select({ id: polyTraderWallets.id })
    .from(polyTraderWallets)
    .where(
      and(
        eq(polyTraderWallets.walletAddress, input.address.toLowerCase()),
        eq(polyTraderWallets.activeForResearch, true),
        isNull(polyTraderWallets.disabledAt)
      )
    )
    .limit(1);
  const traderWalletId = wallet[0]?.id;
  if (!traderWalletId) return { points: [], status: "wallet_missing" };

  // task.5018: push the window's `ts >=` bound into SQL so Postgres returns
  // only the windowed rows instead of the wallet's entire stored series.
  // `windowStart` is the same cutoff `filterPnlHistory` applies (null for
  // ALL / unparseable capturedAt = no bound), so the JS filter below is a
  // no-op refinement kept for the floor-to-second edge (see pnlWindowStart).
  const windowStart = pnlWindowStart(input.interval, capturedAt);
  const rows = await input.db
    .select({
      ts: polyTraderUserPnlPoints.ts,
      pnlUsdc: polyTraderUserPnlPoints.pnlUsdc,
    })
    .from(polyTraderUserPnlPoints)
    .where(
      and(
        eq(polyTraderUserPnlPoints.traderWalletId, traderWalletId),
        eq(polyTraderUserPnlPoints.fidelity, fidelity),
        windowStart ? gte(polyTraderUserPnlPoints.ts, windowStart) : undefined
      )
    )
    .orderBy(asc(polyTraderUserPnlPoints.ts));

  const points: PolymarketUserPnlPoint[] = rows.map((row) => ({
    t: Math.floor(row.ts.getTime() / 1_000),
    p: Number(row.pnlUsdc),
  }));
  const history = filterPnlHistory(points, input.interval, capturedAt).map(
    (point) => ({
      ts: new Date(point.t * 1_000).toISOString(),
      pnl: roundUsd(point.p),
    })
  );
  return {
    points: history,
    status: history.length > 0 ? "available" : "no_history",
  };
}

/**
 * Compatibility reader for non-dashboard consumers that only need points.
 * Dashboard routes use `getTradingWalletPnlHistoryRead` so missing observer
 * state survives the service boundary as an explicit warning.
 */
export async function getTradingWalletPnlHistory(input: {
  db: Db;
  address: `0x${string}`;
  interval: PolyWalletOverviewInterval;
  capturedAt?: string;
}): Promise<PolyWalletOverviewPnlPoint[]> {
  return (await getTradingWalletPnlHistoryRead(input)).points;
}

/** Writer: fetch live `/user-pnl` at both fidelities for one wallet and upsert. */
export async function fetchAndPersistTradingWalletPnlHistory(input: {
  db: Db;
  traderWalletId: string;
  walletAddress: `0x${string}`;
  client?: PolymarketUserPnlClient;
  logger?: UserPnlOutboundLogger;
  component?: string;
  /** Cooperative cancellation (task.5015): checked between interval plans and passed to the upstream fetch. */
  signal?: AbortSignal | undefined;
}): Promise<{ inserted: number; fidelities: Fidelity[] }> {
  const client = input.client ?? getUserPnlClient();
  const plans: Array<{
    fidelity: Fidelity;
    interval: "1w" | "all";
    upstreamFidelity: "1h" | "1d";
  }> = [
    { fidelity: HOUR_FIDELITY, interval: "1w", upstreamFidelity: "1h" },
    { fidelity: DAY_FIDELITY, interval: "all", upstreamFidelity: "1d" },
  ];

  let inserted = 0;
  const fidelities: Fidelity[] = [];
  for (const plan of plans) {
    input.signal?.throwIfAborted();
    const points = await client.getUserPnl(
      input.walletAddress,
      {
        interval: plan.interval,
        fidelity: plan.upstreamFidelity,
      },
      {
        signal: input.signal,
        ...(input.logger
          ? {
              logger: input.logger,
              component: input.component ?? "trader-observation",
            }
          : {}),
      }
    );
    if (points.length === 0) continue;
    // bug.5011: upstream returns the current bucket twice during the active
    // period; PG rejects ON CONFLICT batches that hit the same target twice.
    const deduped = dedupeByKey(points, (p) => p.t);
    const rows = deduped.map((point) => ({
      traderWalletId: input.traderWalletId,
      fidelity: plan.fidelity,
      ts: new Date(point.t * 1_000),
      pnlUsdc: roundUsd(point.p).toFixed(8),
    }));
    await input.db
      .insert(polyTraderUserPnlPoints)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          polyTraderUserPnlPoints.traderWalletId,
          polyTraderUserPnlPoints.fidelity,
          polyTraderUserPnlPoints.ts,
        ],
        set: {
          pnlUsdc: sql`excluded.pnl_usdc`,
          observedAt: sql`now()`,
        },
      });
    inserted += rows.length;
    fidelities.push(plan.fidelity);
  }
  return { inserted, fidelities };
}

/** Retention helper: prune `1h` rows older than 35 days. `1d` kept indefinitely. */
export async function pruneOldTradingWalletPnlPoints(
  db: Db
): Promise<{ deleted: number }> {
  const cutoff = new Date(
    Date.now() - HOUR_FIDELITY_RETENTION_DAYS * 86_400_000
  );
  const result = await db
    .delete(polyTraderUserPnlPoints)
    .where(
      and(
        eq(polyTraderUserPnlPoints.fidelity, HOUR_FIDELITY),
        lt(polyTraderUserPnlPoints.ts, cutoff)
      )
    );
  // drizzle returns driver-specific shapes; cast loosely for postgres-js / node-postgres parity.
  const rowCount =
    (result as unknown as { rowCount?: number; count?: number }).rowCount ??
    (result as unknown as { rowCount?: number; count?: number }).count ??
    0;
  return { deleted: rowCount };
}

function readFidelityForInterval(
  interval: PolyWalletOverviewInterval
): Fidelity {
  switch (interval) {
    case "1D":
    case "1W":
      return HOUR_FIDELITY;
    case "1M":
    case "1Y":
    case "YTD":
    case "ALL":
      return DAY_FIDELITY;
  }
}

/**
 * SQL-pushdown twin of `filterPnlHistory` (task.5018): the timestamptz cutoff
 * for the requested interval, or null when there is no bound (ALL, or an
 * unparseable capturedAt — the same cases where `filterPnlHistory` returns
 * the series unfiltered). The SQL bound `ts >= cutoff` is a superset of the
 * JS predicate `floor(ts/1s)*1s >= cutoff` (flooring only moves timestamps
 * earlier), so applying both yields byte-identical output to JS-only.
 */
function pnlWindowStart(
  interval: PolyWalletOverviewInterval,
  capturedAtIso: string
): Date | null {
  if (interval === "ALL") return null;
  const capturedAtMs = new Date(capturedAtIso).getTime();
  if (!Number.isFinite(capturedAtMs)) return null;
  return new Date(windowStartMs(interval, capturedAtMs));
}

function filterPnlHistory(
  points: readonly PolymarketUserPnlPoint[],
  interval: PolyWalletOverviewInterval,
  capturedAtIso: string
): PolymarketUserPnlPoint[] {
  if (interval === "ALL") return [...points];

  const capturedAtMs = new Date(capturedAtIso).getTime();
  if (!Number.isFinite(capturedAtMs)) return [...points];

  const startMs = windowStartMs(interval, capturedAtMs);
  return points.filter((point) => point.t * 1_000 >= startMs);
}

function windowStartMs(
  interval: Exclude<PolyWalletOverviewInterval, "ALL">,
  capturedAtMs: number
): number {
  switch (interval) {
    case "1D":
      return capturedAtMs - 86_400_000;
    case "1W":
      return capturedAtMs - 7 * 86_400_000;
    case "1M":
      return capturedAtMs - 30 * 86_400_000;
    case "1Y":
      return capturedAtMs - 365 * 86_400_000;
    case "YTD": {
      const now = new Date(capturedAtMs);
      return Date.UTC(now.getUTCFullYear(), 0, 1);
    }
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
