// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/top-wallet-stats.int.test`
 * Purpose: Prove the bug.5017 top-wallets observation tick + DB reader against
 *          a real Postgres — tick upserts leaderboard rows for every
 *          (timePeriod × orderBy) board, the reader serves the exact
 *          `WalletTopTradersOutput` contract from saved facts only, wallets
 *          that leave a board are pruned, a failed board fetch keeps stale
 *          rows, and a cold-start (empty table) read returns an empty 200-shaped
 *          payload rather than reaching upstream.
 * Scope: DB-backed tests for `runTopWalletStatsTick` + `readTopTradersFromDb`
 *        with a fake Polymarket Data API client. Does not test the route
 *        wrapper, auth, or the bootstrap job cadence.
 * Invariants:
 *   - COLD_START_EMPTY: empty table → `{ traders: [], totalCount: 0 }`.
 *   - ALL_BOARDS_MIRRORED: one tick writes all 8 boards.
 *   - PRUNE_PER_BOARD: wallets absent from a re-fetched board are deleted.
 *   - STALE_OVER_EMPTY: a board whose leaderboard fetch throws keeps its rows.
 *   - CONTRACT_PARITY: reader output matches the pre-bug.5017 fan-out mapping
 *     (userName fallback, roiPct, numTradesCapped).
 * Side-effects: IO (database operations via testcontainers)
 * Links: work/items/bug.5017,
 *        src/features/wallet-analysis/server/top-wallet-stats-service.ts
 * @public
 */

import { polyTopWalletStats } from "@cogni/poly-db-schema/trader-activity";
import { noopLogger, noopMetrics } from "@cogni/poly-market-provider";
import {
  type PolymarketLeaderboardEntry,
  type PolymarketUserTrade,
  PolymarketUserTradeSchema,
} from "@cogni/poly-market-provider/adapters/polymarket";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readTopTradersFromDb,
  runTopWalletStatsTick,
  type TopWalletStatsDataApi,
} from "@/features/wallet-analysis/server/top-wallet-stats-service";

const WALLET_A = `0x${"a1".repeat(20)}`;
const WALLET_B = `0x${"b2".repeat(20)}`;
const WALLET_C = `0x${"c3".repeat(20)}`;

type TickDb = Parameters<typeof runTopWalletStatsTick>[0]["db"];

function db(): TickDb {
  return getSeedDb() as unknown as TickDb;
}

function boardEntry(
  rank: number,
  wallet: string,
  overrides?: Partial<PolymarketLeaderboardEntry>
): PolymarketLeaderboardEntry {
  return {
    rank: String(rank),
    proxyWallet: wallet,
    userName: `user-${rank}`,
    xUsername: "",
    verifiedBadge: rank === 1,
    vol: 1000 * rank,
    pnl: 100 * rank,
    profileImage: "",
    ...overrides,
  };
}

function fakeTrades(wallet: string, count: number): PolymarketUserTrade[] {
  return Array.from({ length: count }, (_, i) =>
    PolymarketUserTradeSchema.parse({
      proxyWallet: wallet,
      side: "BUY",
      asset: "asset-1",
      conditionId: "0xcond",
      size: 1,
      price: 0.5,
      timestamp: 1_700_000_000 + i,
    })
  );
}

/**
 * Fake Data API: same board for every (timePeriod, orderBy) combo; /trades
 * counts per wallet configurable; both calls recordable/failable.
 */
function makeFakeDataApi(config: {
  entries: PolymarketLeaderboardEntry[];
  tradesByWallet?: Record<string, number>;
  failTradesFor?: string[];
  failBoards?: Array<{ timePeriod: string; orderBy: string }>;
}): TopWalletStatsDataApi & { leaderboardCalls: number; tradesCalls: number } {
  const fake = {
    leaderboardCalls: 0,
    tradesCalls: 0,
    listTopTraders: async (params?: {
      timePeriod?: string;
      orderBy?: string;
      limit?: number;
    }): Promise<PolymarketLeaderboardEntry[]> => {
      fake.leaderboardCalls += 1;
      const failed = (config.failBoards ?? []).some(
        (b) =>
          b.timePeriod === params?.timePeriod && b.orderBy === params?.orderBy
      );
      if (failed) throw new Error("upstream 429");
      return config.entries;
    },
    listUserActivity: async (
      wallet: string
    ): Promise<PolymarketUserTrade[]> => {
      fake.tradesCalls += 1;
      if ((config.failTradesFor ?? []).includes(wallet)) {
        throw new Error("upstream timeout");
      }
      return fakeTrades(wallet, config.tradesByWallet?.[wallet] ?? 0);
    },
  };
  return fake as unknown as TopWalletStatsDataApi & {
    leaderboardCalls: number;
    tradesCalls: number;
  };
}

async function wipe(): Promise<void> {
  await getSeedDb().delete(polyTopWalletStats);
}

beforeAll(wipe);
afterAll(wipe);

describe("top-wallet-stats tick + reader (bug.5017)", () => {
  it("cold start: empty table returns an empty contract-shaped payload, no upstream call", async () => {
    const result = await readTopTradersFromDb(db(), {
      timePeriod: "WEEK",
      orderBy: "PNL",
      limit: 100,
    });
    expect(result).toEqual({
      traders: [],
      timePeriod: "WEEK",
      orderBy: "PNL",
      totalCount: 0,
    });
  });

  it("tick upserts every (timePeriod × orderBy) board and the reader serves the contract", async () => {
    const client = makeFakeDataApi({
      entries: [
        boardEntry(1, WALLET_A, { userName: "alpha" }),
        boardEntry(2, WALLET_B, { userName: "" }),
        boardEntry(3, WALLET_C, { vol: 0, pnl: 500 }),
      ],
      tradesByWallet: { [WALLET_A]: 500, [WALLET_B]: 3 },
      failTradesFor: [WALLET_C],
    });

    const tick = await runTopWalletStatsTick({
      db: db(),
      dataApiClient: client,
      logger: noopLogger,
      metrics: noopMetrics,
    });

    expect(tick.boards).toBe(8);
    expect(tick.boardErrors).toBe(0);
    expect(tick.upserted).toBe(24); // 8 boards × 3 wallets
    expect(tick.enrichmentErrors).toBe(1);
    // One /trades call per unique wallet, not per board membership.
    expect(client.tradesCalls).toBe(3);
    expect(client.leaderboardCalls).toBe(8);

    const result = await readTopTradersFromDb(db(), {
      timePeriod: "WEEK",
      orderBy: "PNL",
      limit: 100,
    });
    expect(result.timePeriod).toBe("WEEK");
    expect(result.orderBy).toBe("PNL");
    expect(result.totalCount).toBe(3);
    expect(result.traders).toEqual([
      {
        rank: 1,
        proxyWallet: WALLET_A,
        userName: "alpha",
        volumeUsdc: 1000,
        pnlUsdc: 100,
        roiPct: 10,
        numTrades: 500,
        numTradesCapped: true,
        verified: true,
      },
      {
        rank: 2,
        proxyWallet: WALLET_B,
        // Empty vendor username falls back to the wallet address.
        userName: WALLET_B,
        volumeUsdc: 2000,
        pnlUsdc: 200,
        roiPct: 10,
        numTrades: 3,
        numTradesCapped: false,
        verified: false,
      },
      {
        rank: 3,
        proxyWallet: WALLET_C,
        userName: "user-3",
        volumeUsdc: 0,
        pnlUsdc: 500,
        roiPct: null, // zero volume → null, never Infinity
        numTrades: 0, // enrichment failure persists 0, matching old behaviour
        numTradesCapped: false,
        verified: false,
      },
    ]);

    // limit is honored.
    const limited = await readTopTradersFromDb(db(), {
      timePeriod: "MONTH",
      orderBy: "VOL",
      limit: 2,
    });
    expect(limited.totalCount).toBe(2);
    expect(limited.traders.map((t) => t.rank)).toEqual([1, 2]);
  });

  it("prunes wallets that left a board and keeps stale rows for failed boards", async () => {
    // Second tick: WALLET_C left every board; the DAY/PNL board fetch fails.
    const client = makeFakeDataApi({
      entries: [
        boardEntry(1, WALLET_B, { userName: "beta-promoted" }),
        boardEntry(2, WALLET_A, { userName: "alpha" }),
      ],
      tradesByWallet: { [WALLET_A]: 7, [WALLET_B]: 9 },
      failBoards: [{ timePeriod: "DAY", orderBy: "PNL" }],
    });

    const tick = await runTopWalletStatsTick({
      db: db(),
      dataApiClient: client,
      logger: noopLogger,
      metrics: noopMetrics,
    });

    expect(tick.boards).toBe(7);
    expect(tick.boardErrors).toBe(1);
    expect(tick.upserted).toBe(14); // 7 boards × 2 wallets
    expect(tick.pruned).toBe(7); // WALLET_C removed from each refreshed board

    // Refreshed board: pruned + re-ranked.
    const week = await readTopTradersFromDb(db(), {
      timePeriod: "WEEK",
      orderBy: "PNL",
      limit: 100,
    });
    expect(week.traders.map((t) => [t.rank, t.proxyWallet])).toEqual([
      [1, WALLET_B],
      [2, WALLET_A],
    ]);
    expect(week.traders[0]?.userName).toBe("beta-promoted");
    expect(week.traders[0]?.numTrades).toBe(9);

    // Failed board: stale rows (including WALLET_C) intact.
    const day = await readTopTradersFromDb(db(), {
      timePeriod: "DAY",
      orderBy: "PNL",
      limit: 100,
    });
    expect(day.totalCount).toBe(3);
    expect(day.traders.map((t) => t.proxyWallet)).toEqual([
      WALLET_A,
      WALLET_B,
      WALLET_C,
    ]);
  });
});
