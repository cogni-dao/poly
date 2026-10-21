// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/trading-wallet-overview-service`
 * Purpose: DB-backed read of saved Polymarket user-pnl points + writer that
 *          ingests live `/user-pnl` into the same table from the observation tick.
 * Scope: Read + write + retention helpers. Reader is page-load safe (no outbound
 *        HTTP). Writer runs in poll/refresh jobs only.
 * Invariants:
 *   - PNL_NOT_NAV: LIVE is saved provider P/L. PAPER is private, prospective
 *     cumulative saved NAV minus its declared seed, always partial history.
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
import { and, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { derivePaperAccountAddress } from "@/features/paper-accounts";
import { withResearchReadTimeout } from "./fill-rollup-service";
import { dedupeByKey } from "./observation-helpers";
import { portfolioWindowStart } from "./portfolio-window";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

type Fidelity = "1h" | "1d";
const HOUR_FIDELITY: Fidelity = "1h";
const DAY_FIDELITY: Fidelity = "1d";

/** `1h` rows older than this are pruned by the writer's tick. */
const HOUR_FIDELITY_RETENTION_DAYS = 35;
const PNL_READ_LIMIT = 2_000;
const PNL_FRESHNESS_MS = 10 * 60_000;

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
  | "partial"
  | "unavailable"
  | "available"
  | "no_history"
  | "stale"
  | "wallet_missing";

export interface TradingWalletPnlHistoryRead {
  points: PolyWalletOverviewPnlPoint[];
  status: TradingWalletPnlHistoryStatus;
  observedAt?: string;
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
  /** Internal coherent tenant-snapshot context, never a public request flag. */
  paper?: { billingAccountId: string; generation: string; navUsdc: number };
}): Promise<TradingWalletPnlHistoryRead> {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const fidelity = readFidelityForInterval(input.interval);
  if (input.paper) return readPrivatePaperPnl({ ...input, capturedAt, fidelity, paper: input.paper });
  const { traderWalletId, rows } = await withResearchReadTimeout(
    input.db,
    async (tx) => {
      const wallet = await tx
        .select({ id: polyTraderWallets.id })
        .from(polyTraderWallets)
        .where(
          and(
            eq(polyTraderWallets.walletAddress, input.address.toLowerCase()),
            ne(polyTraderWallets.kind, "paper_wallet"),
            eq(polyTraderWallets.activeForResearch, true),
            isNull(polyTraderWallets.disabledAt)
          )
        )
        .limit(1);
      const traderWalletId = wallet[0]?.id;
      if (!traderWalletId) return { traderWalletId: undefined, rows: [] };

      // task.5018: push the window's `ts >=` bound into SQL so Postgres returns
      // only the windowed rows instead of the wallet's entire stored series.
      // `windowStart` is the same cutoff `filterPnlHistory` applies (null for
      // ALL / unparseable capturedAt = no bound), so the JS filter below is a
      // no-op refinement kept for the floor-to-second edge.
      const windowStart = portfolioWindowStart(input.interval, capturedAt);
      const rows = await tx
        .select({
          ts: polyTraderUserPnlPoints.ts,
          pnlUsdc: polyTraderUserPnlPoints.pnlUsdc,
          observedAt: polyTraderUserPnlPoints.observedAt,
        })
        .from(polyTraderUserPnlPoints)
        .where(
          and(
            eq(polyTraderUserPnlPoints.traderWalletId, traderWalletId),
            eq(polyTraderUserPnlPoints.fidelity, fidelity),
            windowStart ? gte(polyTraderUserPnlPoints.ts, windowStart) : undefined
          )
        )
        .orderBy(desc(polyTraderUserPnlPoints.ts))
        .limit(PNL_READ_LIMIT);
      return { traderWalletId, rows };
    }
  );
  if (!traderWalletId) return { points: [], status: "wallet_missing" };

  rows.reverse();
  const latestObservedAt = rows.reduce<Date | null>(
    (latest, row) =>
      latest === null || row.observedAt > latest ? row.observedAt : latest,
    null
  );

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
  if (history.length === 0 || latestObservedAt === null) {
    return { points: [], status: "no_history" };
  }
  const observedAt = latestObservedAt.toISOString();
  if (
    new Date(capturedAt).getTime() - latestObservedAt.getTime() >
    PNL_FRESHNESS_MS
  ) {
    return { points: [], status: "stale", observedAt };
  }
  return { points: history, status: "available", observedAt };
}

/** Existing tenant RLS is mandatory: an address or service handle conveys no authority. */
async function readPrivatePaperPnl(input: {
  db: Db; address: `0x${string}`; interval: PolyWalletOverviewInterval;
  capturedAt: string; fidelity: Fidelity;
  paper: { billingAccountId: string; generation: string; navUsdc: number };
}): Promise<TradingWalletPnlHistoryRead> {
  const unavailable: TradingWalletPnlHistoryRead = { points: [], status: "unavailable" };
  const captured = new Date(input.capturedAt);
  const generation = new Date(input.paper.generation);
  const expected = derivePaperAccountAddress(input.paper.billingAccountId);
  if (input.address.toLowerCase() !== expected || !Number.isFinite(captured.getTime()) ||
    !Number.isFinite(generation.getTime()) || generation > captured ||
    captured.getTime() - generation.getTime() > PNL_FRESHNESS_MS || !Number.isFinite(input.paper.navUsdc)) return unavailable;
  return withResearchReadTimeout(input.db, async (tx) => {
    const rowsOf = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] :
      ((value as { rows?: T[] }).rows ?? []);
    const guard = rowsOf<{ allowed: boolean }>(await tx.execute(sql`
      SELECT nullif(current_setting('app.current_user_id', true), '') IS NOT NULL
        AND row_security_active('poly_wallet_connections'::regclass)
        AND row_security_active('poly_wallet_balance_snapshots'::regclass) AS allowed
    `))[0];
    if (!guard?.allowed) return unavailable;
    // All retained lifecycles count, including revoked/address-mismatched rows.
    const valid = rowsOf<{ wallet_id: string; created_at: Date | string }>(await tx.execute(sql`
      WITH connections AS MATERIALIZED (
        SELECT * FROM poly_wallet_connections WHERE billing_account_id = ${input.paper.billingAccountId} AND kind = 'paper'
      )
      SELECT w.id AS wallet_id, c.created_at FROM connections c
      JOIN poly_trader_wallets w ON lower(w.wallet_address) = ${expected} AND w.kind = 'paper_wallet'
        AND w.active_for_research AND w.disabled_at IS NULL AND w.created_at >= c.created_at
      JOIN poly_wallet_balance_snapshots b ON b.billing_account_id = c.billing_account_id
        AND lower(b.address) = ${expected} AND b.observed_at = ${generation}::timestamptz
      JOIN poly_trader_ingestion_cursors cursor ON cursor.trader_wallet_id = w.id
        AND cursor.source = 'paper-ledger-positions' AND cursor.status = 'ok'
        AND cursor.last_success_at = b.observed_at
      WHERE (SELECT count(*) FROM connections) = 1 AND c.revoked_at IS NULL
        AND lower(c.address) = ${expected} AND lower(c.funder_address) = ${expected}
        AND c.paper_seed_usdc > 0 AND c.paper_seed_usdc NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND b.usdc_e = ${input.paper.navUsdc.toFixed(8)}::numeric
        AND b.usdc_e NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
        AND c.created_at <= ${generation}::timestamptz AND w.created_at <= ${generation}::timestamptz
        AND NOT EXISTS (
          SELECT 1 FROM (VALUES ('1h'), ('1d')) f(fidelity)
          LEFT JOIN LATERAL (
            SELECT p.* FROM poly_trader_user_pnl_points p WHERE p.trader_wallet_id = w.id AND p.fidelity = f.fidelity
            ORDER BY p.observed_at DESC, p.ts DESC LIMIT 1
          ) latest ON true
          WHERE latest.observed_at IS DISTINCT FROM b.observed_at
            OR latest.pnl_usdc IS DISTINCT FROM (b.usdc_e - c.paper_seed_usdc)::numeric(38,8)
            OR latest.ts > ${captured}::timestamptz
            OR latest.ts IS DISTINCT FROM (date_trunc(CASE f.fidelity WHEN '1h' THEN 'hour' ELSE 'day' END,
              latest.observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        )
    `));
    if (valid.length !== 1 || !valid[0]) return unavailable;
    const wallet = valid[0];
    const start = portfolioWindowStart(input.interval, input.capturedAt);
    const rows = rowsOf<{ observed_at: Date | string; pnl_usdc: string }>(await tx.execute(sql`
      SELECT observed_at, pnl_usdc FROM poly_trader_user_pnl_points
      WHERE trader_wallet_id = ${wallet.wallet_id}::uuid AND fidelity = ${input.fidelity}
        AND observed_at >= ${new Date(wallet.created_at)}::timestamptz
        ${start ? sql`AND observed_at >= ${start}::timestamptz` : sql``}
        AND observed_at <= ${captured}::timestamptz AND ts <= ${captured}::timestamptz
        AND ts = (date_trunc(${input.fidelity === "1h" ? "hour" : "day"}, observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      ORDER BY observed_at DESC LIMIT ${PNL_READ_LIMIT}
    `));
    if (rows.length === 0) return { points: [], status: "no_history" };
    if (rows.some((row) => !Number.isFinite(Number(row.pnl_usdc)) || !Number.isFinite(new Date(row.observed_at).getTime()))) return unavailable;
    return { status: "partial", observedAt: generation.toISOString(), points: rows.reverse().map((row) => ({
      ts: new Date(row.observed_at).toISOString(), pnl: roundUsd(Number(row.pnl_usdc)),
    })) };
  });
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

function filterPnlHistory(
  points: readonly PolymarketUserPnlPoint[],
  interval: PolyWalletOverviewInterval,
  capturedAtIso: string
): PolymarketUserPnlPoint[] {
  if (interval === "ALL") return [...points];

  const capturedAtMs = new Date(capturedAtIso).getTime();
  if (!Number.isFinite(capturedAtMs)) return [...points];

  const windowStart = portfolioWindowStart(interval, capturedAtIso);
  if (windowStart === null) return [...points];
  const startMs = windowStart.getTime();
  return points.filter((point) => point.t * 1_000 >= startMs);
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}
