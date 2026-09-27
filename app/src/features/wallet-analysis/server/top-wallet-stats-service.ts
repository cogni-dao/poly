// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/top-wallet-stats-service`
 * Purpose: Mirror the Polymarket `/v1/leaderboard` (plus the per-wallet
 *          `/trades`-count enrichment) into `poly_top_wallet_stats` so the
 *          Top Wallets dashboard/research card reads from our DB, never from
 *          upstream on render (bug.5017).
 * Scope: Tick writer + DB reader. Reader is page-load safe (no outbound HTTP);
 *        writer runs in the top-wallet-stats bootstrap job only.
 * Invariants:
 *   - PAGE_LOAD_DB_ONLY (bug.5017): `readTopTradersFromDb` performs no
 *     outbound HTTP. The route/capability must import only the reader.
 *   - ALL_BOARDS_MIRRORED: the tick refreshes every (timePeriod × orderBy)
 *     combination the route contract accepts (4 × 2 = 8 boards), so any
 *     query the UI can issue is served from saved facts.
 *   - WRITERS_RESPECT_RATE_LIMITS: leaderboard + per-wallet /trades calls run
 *     through `pLimit(4)` (spike.5001's measured-safe upstream concurrency).
 *   - PRUNE_PER_BOARD: after a successful board fetch, rows for wallets that
 *     left that board are deleted in the same transaction as the upsert. A
 *     failed board fetch leaves that board's stale rows intact (stale > empty).
 *   - CONTRACT_PARITY: row mapping preserves the exact `WalletTopTraderItem`
 *     semantics the old render-path fan-out produced (userName fallback to
 *     address, roiPct null on zero volume, numTrades 0 on enrichment failure,
 *     numTradesCapped at the 500-row /trades ceiling).
 * Side-effects:
 *   - Writer: IO (Polymarket Data API) + DB upsert/delete.
 *   - Reader: DB read.
 * Links: packages/db-schema/src/trader-activity.ts,
 *        src/bootstrap/jobs/top-wallet-stats.job.ts, work/items/bug.5017
 * @public
 */

import { polyTopWalletStats } from "@cogni/poly-db-schema/trader-activity";
import type {
  WalletOrderBy,
  WalletTimePeriod,
  WalletTopTraderItem,
  WalletTopTradersOutput,
} from "@cogni/poly-ai-tools";
import type { LoggerPort, MetricsPort } from "@cogni/poly-market-provider";
import type {
  PolymarketDataApiClient,
  PolymarketLeaderboardEntry,
} from "@cogni/poly-market-provider/adapters/polymarket";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import pLimit from "p-limit";

type Db =
  | NodePgDatabase<Record<string, unknown>>
  | PostgresJsDatabase<Record<string, unknown>>;

/** Narrow client surface the tick needs — fakes implement exactly this. */
export type TopWalletStatsDataApi = Pick<
  PolymarketDataApiClient,
  "listTopTraders" | "listUserActivity"
>;

export const TOP_WALLET_TIME_PERIODS = [
  "DAY",
  "WEEK",
  "MONTH",
  "ALL",
] as const satisfies readonly WalletTimePeriod[];
export const TOP_WALLET_ORDER_BYS = [
  "PNL",
  "VOL",
] as const satisfies readonly WalletOrderBy[];

/**
 * Rows fetched per board. Matches the route contract's max `limit` (200) so
 * the DB always holds at least as many rows as any request can ask for.
 * Upstream may return fewer.
 */
const DEFAULT_LEADERBOARD_LIMIT = 200;

/**
 * Cap applied to the enrichment `/trades` call per wallet. API pagination caps
 * at 500; `numTradesCapped=true` is surfaced when saturated so readers know
 * the count is a lower bound. (Unchanged from the pre-bug.5017 render path.)
 */
const TRADES_ENRICHMENT_LIMIT = 500;

/** Upstream concurrency cap — spike.5001 measured pLimit(4) as 429-safe. */
const DEFAULT_CONCURRENCY = 4;

const WALLET_SHAPE = /^0x[a-fA-F0-9]{40}$/;

export interface TopWalletStatsTickDeps {
  db: Db;
  dataApiClient: TopWalletStatsDataApi;
  logger: LoggerPort;
  metrics: MetricsPort;
  /** Rows requested per board. Default 200 (route contract max). */
  leaderboardLimit?: number;
  /** Upstream concurrency cap. Default 4. */
  concurrency?: number;
}

export interface TopWalletStatsTickResult {
  /** Boards successfully fetched (of the 8 timePeriod × orderBy combos). */
  boards: number;
  /** Boards whose leaderboard fetch failed (stale rows left intact). */
  boardErrors: number;
  /** Unique wallets enriched with a /trades count. */
  walletsEnriched: number;
  /** Wallets whose /trades enrichment failed (numTrades persisted as 0). */
  enrichmentErrors: number;
  /** Rows upserted across all boards. */
  upserted: number;
  /** Rows pruned (wallets that left a board). */
  pruned: number;
}

/** Insert-shaped row for `poly_top_wallet_stats`. */
export interface TopWalletStatRow {
  timePeriod: WalletTimePeriod;
  orderBy: WalletOrderBy;
  walletAddress: string;
  rank: number;
  userName: string;
  volumeUsdc: string;
  pnlUsdc: string;
  roiPct: string | null;
  numTrades: number;
  numTradesCapped: boolean;
  verified: boolean;
  raw: Record<string, unknown>;
  capturedAt: Date;
}

/**
 * `roi_pct` column is numeric(18,8) → |value| < 10^10. A near-zero volume
 * with a large pnl could overflow; clamp so one pathological row cannot fail
 * a whole board's upsert.
 */
const ROI_PCT_CLAMP = 1_000_000_000;

/**
 * Map one vendor leaderboard entry to a `poly_top_wallet_stats` row.
 * Returns null for entries whose proxyWallet fails the address-shape check
 * (the table CHECK would reject them and fail the whole board insert).
 *
 * Exported for unit tests.
 */
export function mapLeaderboardEntryToRow(input: {
  entry: PolymarketLeaderboardEntry;
  /** 0-indexed position within the board; rank fallback when unparsable. */
  index: number;
  timePeriod: WalletTimePeriod;
  orderBy: WalletOrderBy;
  numTrades: number;
  capturedAt: Date;
}): TopWalletStatRow | null {
  const { entry } = input;
  if (!WALLET_SHAPE.test(entry.proxyWallet)) return null;

  const parsedRank = Number.parseInt(entry.rank, 10);
  const rank =
    Number.isInteger(parsedRank) && parsedRank > 0
      ? parsedRank
      : input.index + 1;

  const roiPct =
    entry.vol > 0
      ? Math.max(
          -ROI_PCT_CLAMP,
          Math.min(ROI_PCT_CLAMP, (entry.pnl / entry.vol) * 100)
        )
      : null;

  return {
    timePeriod: input.timePeriod,
    orderBy: input.orderBy,
    walletAddress: entry.proxyWallet,
    rank,
    userName: entry.userName ?? "",
    volumeUsdc: String(entry.vol),
    pnlUsdc: String(entry.pnl),
    roiPct: roiPct === null ? null : String(roiPct),
    numTrades: input.numTrades,
    numTradesCapped: input.numTrades >= TRADES_ENRICHMENT_LIMIT,
    verified: entry.verifiedBadge,
    raw: entry as unknown as Record<string, unknown>,
    capturedAt: input.capturedAt,
  };
}

/**
 * Writer tick — sibling of `runMarketOutcomeTick` / `runPriceHistoryTick`.
 * Fetches every (timePeriod × orderBy) leaderboard, enriches each unique
 * wallet with a `/trades` count, then per board upserts rows and prunes
 * wallets that left the board.
 */
export async function runTopWalletStatsTick(
  deps: TopWalletStatsTickDeps
): Promise<TopWalletStatsTickResult> {
  const log = deps.logger.child({ component: "top-wallet-stats" });
  const client = deps.dataApiClient;
  const leaderboardLimit = deps.leaderboardLimit ?? DEFAULT_LEADERBOARD_LIMIT;
  const limit = pLimit(deps.concurrency ?? DEFAULT_CONCURRENCY);
  const capturedAt = new Date();

  // 1. Fetch every board through the shared concurrency cap. A failed board
  //    is skipped (stale rows kept) rather than failing the tick.
  const boards: Array<{
    timePeriod: WalletTimePeriod;
    orderBy: WalletOrderBy;
    entries: PolymarketLeaderboardEntry[];
  }> = [];
  let boardErrors = 0;
  await Promise.all(
    TOP_WALLET_TIME_PERIODS.flatMap((timePeriod) =>
      TOP_WALLET_ORDER_BYS.map((orderBy) =>
        limit(async () => {
          try {
            const entries = await client.listTopTraders({
              timePeriod,
              orderBy,
              limit: leaderboardLimit,
            });
            boards.push({ timePeriod, orderBy, entries });
          } catch (err: unknown) {
            boardErrors += 1;
            log.warn(
              {
                event: "poly.top-wallet-stats.board_fetch_failed",
                time_period: timePeriod,
                order_by: orderBy,
                err: err instanceof Error ? err.message : String(err),
              },
              "top-wallet-stats: leaderboard fetch failed; keeping stale rows for this board"
            );
          }
        })
      )
    )
  );

  // 2. Enrich each unique wallet once (a wallet on several boards costs one
  //    call). Best-effort: a failed /trades call persists numTrades=0, same
  //    as the pre-bug.5017 render path.
  const uniqueWallets = new Set<string>();
  for (const board of boards) {
    for (const entry of board.entries) {
      if (WALLET_SHAPE.test(entry.proxyWallet)) {
        uniqueWallets.add(entry.proxyWallet);
      }
    }
  }
  const numTradesByWallet = new Map<string, number>();
  let enrichmentErrors = 0;
  await Promise.all(
    Array.from(uniqueWallets, (wallet) =>
      limit(async () => {
        try {
          const trades = await client.listUserActivity(wallet, {
            limit: TRADES_ENRICHMENT_LIMIT,
          });
          numTradesByWallet.set(wallet, trades.length);
        } catch (err: unknown) {
          enrichmentErrors += 1;
          numTradesByWallet.set(wallet, 0);
          log.warn(
            {
              event: "poly.top-wallet-stats.enrichment_failed",
              wallet,
              err: err instanceof Error ? err.message : String(err),
            },
            "top-wallet-stats: /trades enrichment failed; numTrades persisted as 0"
          );
        }
      })
    )
  );

  // 3. Per successfully fetched board: upsert current rows, then prune rows
  //    for wallets no longer on that board — atomically, so a reader never
  //    sees a board that is half old, half new.
  let upserted = 0;
  let pruned = 0;
  for (const board of boards) {
    const rows: TopWalletStatRow[] = [];
    for (const [index, entry] of board.entries.entries()) {
      const row = mapLeaderboardEntryToRow({
        entry,
        index,
        timePeriod: board.timePeriod,
        orderBy: board.orderBy,
        numTrades: numTradesByWallet.get(entry.proxyWallet) ?? 0,
        capturedAt,
      });
      if (row) rows.push(row);
    }

    await deps.db.transaction(async (tx) => {
      if (rows.length > 0) {
        await tx
          .insert(polyTopWalletStats)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              polyTopWalletStats.timePeriod,
              polyTopWalletStats.orderBy,
              polyTopWalletStats.walletAddress,
            ],
            set: {
              rank: sql`EXCLUDED.rank`,
              userName: sql`EXCLUDED.user_name`,
              volumeUsdc: sql`EXCLUDED.volume_usdc`,
              pnlUsdc: sql`EXCLUDED.pnl_usdc`,
              roiPct: sql`EXCLUDED.roi_pct`,
              numTrades: sql`EXCLUDED.num_trades`,
              numTradesCapped: sql`EXCLUDED.num_trades_capped`,
              verified: sql`EXCLUDED.verified`,
              raw: sql`EXCLUDED.raw`,
              capturedAt: sql`EXCLUDED.captured_at`,
            },
          });
      }
      const boardFilter = and(
        eq(polyTopWalletStats.timePeriod, board.timePeriod),
        eq(polyTopWalletStats.orderBy, board.orderBy)
      );
      const pruneWhere =
        rows.length > 0
          ? and(
              boardFilter,
              notInArray(
                polyTopWalletStats.walletAddress,
                rows.map((r) => r.walletAddress)
              )
            )
          : boardFilter;
      const deleted = await tx
        .delete(polyTopWalletStats)
        .where(pruneWhere)
        .returning({ walletAddress: polyTopWalletStats.walletAddress });
      pruned += deleted.length;
    });
    upserted += rows.length;
  }

  const result: TopWalletStatsTickResult = {
    boards: boards.length,
    boardErrors,
    walletsEnriched: uniqueWallets.size - enrichmentErrors,
    enrichmentErrors,
    upserted,
    pruned,
  };
  log.info(
    {
      event: "poly.top-wallet-stats.tick_ok",
      ...result,
    },
    "top-wallet-stats tick complete"
  );
  return result;
}

/**
 * Page-load reader for the Top Wallets card. Single SELECT — no outbound
 * HTTP (PAGE_LOAD_DB_ONLY). Cold start (empty table / board not yet
 * refreshed) returns an empty `traders` list with `totalCount: 0`; it never
 * falls back to upstream on the render path.
 */
export async function readTopTradersFromDb(
  db: Db,
  params: {
    timePeriod: WalletTimePeriod;
    orderBy: WalletOrderBy;
    limit: number;
  }
): Promise<WalletTopTradersOutput> {
  const rows = await db
    .select({
      rank: polyTopWalletStats.rank,
      walletAddress: polyTopWalletStats.walletAddress,
      userName: polyTopWalletStats.userName,
      volumeUsdc: polyTopWalletStats.volumeUsdc,
      pnlUsdc: polyTopWalletStats.pnlUsdc,
      roiPct: polyTopWalletStats.roiPct,
      numTrades: polyTopWalletStats.numTrades,
      numTradesCapped: polyTopWalletStats.numTradesCapped,
      verified: polyTopWalletStats.verified,
    })
    .from(polyTopWalletStats)
    .where(
      and(
        eq(polyTopWalletStats.timePeriod, params.timePeriod),
        eq(polyTopWalletStats.orderBy, params.orderBy)
      )
    )
    .orderBy(asc(polyTopWalletStats.rank), asc(polyTopWalletStats.walletAddress))
    .limit(params.limit);

  const traders: WalletTopTraderItem[] = rows.map((r) => ({
    rank: r.rank,
    proxyWallet: r.walletAddress,
    // Same fallback the render-path fan-out applied: empty username → address.
    userName: r.userName || r.walletAddress,
    volumeUsdc: Number(r.volumeUsdc),
    pnlUsdc: Number(r.pnlUsdc),
    roiPct: r.roiPct === null ? null : Number(r.roiPct),
    numTrades: r.numTrades,
    numTradesCapped: r.numTradesCapped,
    verified: r.verified,
  }));

  return {
    traders,
    timePeriod: params.timePeriod,
    orderBy: params.orderBy,
    totalCount: traders.length,
  };
}
