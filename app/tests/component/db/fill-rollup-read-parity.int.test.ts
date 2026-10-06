// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/fill-rollup-read-parity`
 * Purpose: Parity oracle suite for the rollup-backed research readers
 *   (task.research-rollup-read-models) plus the two dashboard live-scans
 *   ported in the dashboard floor audit wave C
 *   (`realized-pnl-service.readWalletTokenPnlMap`,
 *   `market-exposure-service.readFillRollups`). Each rollup-backed reader
 *   must be exactly output-equivalent to the preserved legacy full-scan SQL
 *   (`@tests/_fixtures/poly/research-live-scan-oracles`) — and to the legacy
 *   JS trade-size/P-L reducer — in EVERY rollup state:
 *     cold    (no rollups: everything served from the fill tail),
 *     partial (some fills rolled, the rest tail),
 *     warm    (fully accumulated),
 *     tail    (fully accumulated + fresh unrolled fills on top).
 *   Windows cover epoch (ALL), a UTC-midnight-aligned start, and a mid-day
 *   start that exercises the boundary-day fragment; fixtures include fills
 *   exactly at midnight, 1ms before the mid-day boundary, exactly at the
 *   window start, and a SELL-only token.
 * Scope: Real testcontainers Postgres via the seed client. No Polymarket IO.
 * Invariants:
 *   - ORACLE_IS_TRUTH: on mismatch, fix the rollup reader or the fixture —
 *     never the oracle (data-research skill § 5).
 * Side-effects: IO (test database seed + cleanup)
 * Links: work/items/task.research-rollup-read-models.md
 * @public
 */

import {
  buildTradeSizePnl,
  type OracleFill,
  type OracleOutcomeRow,
  resolutionsFromOutcomeRows,
} from "@tests/_fixtures/poly/trade-size-pnl-oracle";
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import {
  readBenchmarkMarketRowsOracle,
  readBenchmarkSummaryOracle,
  readMarketFillRollupsOracle,
  readOverlapRowsOracle,
  readPositionAggregatesOracle,
  readTradeSummaryOracle,
  readWalletTokenPnlOracle,
} from "@tests/_fixtures/poly/research-live-scan-oracles";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  polyMarketOutcomes,
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderWallets,
} from "@/shared/db/schema";
import {
  readMarketRows,
  readSummary,
} from "@/features/wallet-analysis/server/copy-target-benchmark-service";
import {
  accumulateFillRollups,
  EPOCH_ISO,
} from "@/features/wallet-analysis/server/fill-rollup-service";
import {
  type FillRollup,
  readFillRollups,
  rollupKey,
} from "@/features/wallet-analysis/server/market-exposure-service";
import { computeRealizedPnl } from "@/features/wallet-analysis/server/market-return-math";
import {
  applyRealizedPnl,
  readWalletTokenPnlMap,
  tokenPnlKey,
  type WalletTokenPnl,
} from "@/features/wallet-analysis/server/realized-pnl-service";
import { readOverlapRows } from "@/features/wallet-analysis/server/target-overlap-service";
import {
  readTradeSizePnl,
  readTradeSummary,
} from "@/features/wallet-analysis/server/trader-comparison-service";
import { readPositionAggregatesFromDb } from "@/features/wallet-analysis/server/wallet-analysis-service";

type ServiceDb = Parameters<typeof readPositionAggregatesFromDb>[0];

const TARGET_ADDRESS = "0xfe11fe11fe11fe11fe11fe11fe11fe11fe11fe11";
const COGNI_ADDRESS = "0xfe22fe22fe22fe22fe22fe22fe22fe22fe22fe22";

/** UTC midnight 10 days ago — all fixture fills predate "now". */
function anchorMidnightMs(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 10
  );
}

const M = anchorMidnightMs();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const M_ISO = new Date(M).toISOString();
/** Mid-day window start: exercises the boundary-day fill fragment. */
const MID_ISO = new Date(M + 5.5 * HOUR).toISOString();
const WINDOWS = [EPOCH_ISO, M_ISO, MID_ISO] as const;

type FillSeed = {
  wallet: "target" | "cogni";
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  sizeUsdc: number;
  observedAtMs: number;
};

// Dyadic sizes (multiples of 0.25) so float64 and numeric agree exactly.
const FILLS: FillSeed[] = [
  // c1/t1y target: pre-window history + exact-midnight + in-window + recent
  { wallet: "target", conditionId: "cp1", tokenId: "tp1y", side: "BUY", sizeUsdc: 10, observedAtMs: M - 2 * HOUR },
  { wallet: "target", conditionId: "cp1", tokenId: "tp1y", side: "BUY", sizeUsdc: 2.5, observedAtMs: M },
  { wallet: "target", conditionId: "cp1", tokenId: "tp1y", side: "SELL", sizeUsdc: 1.25, observedAtMs: M + HOUR },
  // exactly at the mid-day window start (>= boundary: included)
  { wallet: "target", conditionId: "cp1", tokenId: "tp1n", side: "BUY", sizeUsdc: 0.5, observedAtMs: M + 5.5 * HOUR },
  // 1ms before the mid-day window start (excluded from MID window)
  { wallet: "target", conditionId: "cp2", tokenId: "tp2y", side: "BUY", sizeUsdc: 7.75, observedAtMs: M + 5.5 * HOUR - 1 },
  { wallet: "target", conditionId: "cp2", tokenId: "tp2y", side: "BUY", sizeUsdc: 3, observedAtMs: M + 2 * DAY + 3 * HOUR },
  // SELL-only token (no first_buy)
  { wallet: "target", conditionId: "cp3", tokenId: "tp3y", side: "SELL", sizeUsdc: 6, observedAtMs: M + 3 * DAY },
  { wallet: "target", conditionId: "cp1", tokenId: "tp1y", side: "BUY", sizeUsdc: 1.75, observedAtMs: M + 9 * DAY + 3 * HOUR },
  // cogni wallet
  { wallet: "cogni", conditionId: "cp1", tokenId: "tp1y", side: "BUY", sizeUsdc: 4, observedAtMs: M + 1.5 * HOUR },
  { wallet: "cogni", conditionId: "cp2", tokenId: "tp2y", side: "BUY", sizeUsdc: 2, observedAtMs: M + 2 * DAY + 4 * HOUR },
  { wallet: "cogni", conditionId: "cp4", tokenId: "tp4y", side: "BUY", sizeUsdc: 9, observedAtMs: M + DAY },
];

const OUTCOMES: OracleOutcomeRow[] = [
  { conditionId: "cp2", tokenId: "tp2y", outcome: "winner" },
  { conditionId: "cp2", tokenId: "tp2n", outcome: "loser" },
];
const MIXED_CASE_OUTCOMES = ["case-winner-a", "CASE-WINNER-B"] as const;

let targetId = "";
let cogniId = "";
/** Fills added after the warm accumulate to form the unrolled tail state. */
const TAIL_FILLS: FillSeed[] = [
  { wallet: "target", conditionId: "cp2", tokenId: "tp2y", side: "BUY", sizeUsdc: 1.5, observedAtMs: M + 9 * DAY + 5 * HOUR },
  { wallet: "cogni", conditionId: "cp4", tokenId: "tp4y", side: "SELL", sizeUsdc: 0.75, observedAtMs: M + 9 * DAY + 6 * HOUR },
];

async function seedFillBatch(
  fills: readonly FillSeed[],
  idPrefix: string
): Promise<void> {
  const db = getSeedDb();
  await db.insert(polyTraderFills).values(
    fills.map((f, i) => ({
      traderWalletId: f.wallet === "target" ? targetId : cogniId,
      source: "data-api" as const,
      nativeId: `${idPrefix}-${i}`,
      conditionId: f.conditionId,
      tokenId: f.tokenId,
      side: f.side,
      price: "0.5",
      shares: String(f.sizeUsdc * 2),
      sizeUsdc: String(f.sizeUsdc),
      observedAt: new Date(f.observedAtMs),
    }))
  );
}

function toNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => {
      if (v instanceof Date) return [k, v.toISOString()];
      if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) {
        // numeric-ish strings (counts/sums from the drivers) -> number
        return [k, Number(v)];
      }
      return [k, v];
    })
  );
}

function sortByKeys<T extends Record<string, unknown>>(
  rows: readonly T[],
  keys: readonly string[]
): T[] {
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const av = String(a[k] ?? "");
      const bv = String(b[k] ?? "");
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  });
}

/**
 * Assert every rollup-backed reader equals its legacy oracle for all three
 * windows, in the CURRENT rollup state. `allFills` is the fills the JS
 * trade-size oracle should see (grows in the tail state).
 */
async function assertParity(allFills: readonly FillSeed[]): Promise<void> {
  const db = getSeedDb() as unknown as ServiceDb;

  // 1. snapshot position aggregates (full history, per wallet)
  for (const address of [TARGET_ADDRESS, COGNI_ADDRESS]) {
    const actual = sortByKeys(await readPositionAggregatesFromDb(db, address), [
      "conditionId",
      "tokenId",
    ]);
    const expected = sortByKeys(await readPositionAggregatesOracle(db, address), [
      "conditionId",
      "tokenId",
    ]);
    expect(actual).toEqual(expected);
  }

  for (const windowStartIso of WINDOWS) {
    // 2. benchmark market rows + summary (target vs cogni, and no-comparison)
    for (const comparison of [cogniId, null]) {
      const actualMarkets = (
        await readMarketRows(db, targetId, comparison, windowStartIso)
      ).map(normalizeRow);
      const expectedMarkets = (
        await readBenchmarkMarketRowsOracle(db, targetId, comparison, windowStartIso)
      ).map(normalizeRow);
      expect(sortByKeys(actualMarkets, ["condition_id", "token_id"])).toEqual(
        sortByKeys(expectedMarkets, ["condition_id", "token_id"])
      );

      const actualSummary = (
        await readSummary(db, targetId, comparison, windowStartIso)
      ).map(normalizeRow);
      const expectedSummary = (
        await readBenchmarkSummaryOracle(db, targetId, comparison, windowStartIso)
      ).map(normalizeRow);
      expect(actualSummary).toEqual(expectedSummary);
    }

    // 3. target-overlap rows (target plays rn1, cogni plays swisstony)
    const actualOverlap = (
      await readOverlapRows(db, targetId, cogniId, windowStartIso)
    ).map((r) => normalizeRow(r as unknown as Record<string, unknown>));
    const expectedOverlap = (
      await readOverlapRowsOracle(db, targetId, cogniId, windowStartIso)
    ).map(normalizeRow);
    expect(sortByKeys(actualOverlap, ["bucket"])).toEqual(
      sortByKeys(expectedOverlap, ["bucket"])
    );

    // 4. trader-comparison summary + size-P/L per wallet
    for (const address of [TARGET_ADDRESS, COGNI_ADDRESS]) {
      const actualTs = await readTradeSummary(db, address, windowStartIso);
      const expectedTs = await readTradeSummaryOracle(db, address, windowStartIso);
      expect(
        actualTs === null ? null : normalizeRow(actualTs as Record<string, unknown>)
      ).toEqual(expectedTs === null ? null : normalizeRow(expectedTs));

      const actualPnl = await readTradeSizePnl(db, address, windowStartIso);
      const walletKey = address === TARGET_ADDRESS ? "target" : "cogni";
      const oracleFills: OracleFill[] = allFills
        .filter((f) => f.wallet === walletKey)
        .sort((a, b) => a.observedAtMs - b.observedAtMs)
        .map((f) => ({
          conditionId: f.conditionId,
          tokenId: f.tokenId,
          side: f.side,
          price: 0.5,
          shares: f.sizeUsdc * 2,
          sizeUsdc: f.sizeUsdc,
          observedAt: new Date(f.observedAtMs),
        }));
      const expectedPnl = buildTradeSizePnl(
        oracleFills,
        resolutionsFromOutcomeRows(OUTCOMES),
        new Date(windowStartIso)
      );
      expect(actualPnl).toEqual(expectedPnl);
    }
  }

  // 5. wave C: realized-pnl token map (full history) vs preserved live-scan.
  // Mixed-case input exercises the lower() address resolution both paths use.
  for (const address of [TARGET_ADDRESS, COGNI_ADDRESS.toUpperCase()]) {
    const actual = await readWalletTokenPnlMap({ db, walletAddress: address });
    const expected = new Map<string, WalletTokenPnl>();
    for (const row of await readWalletTokenPnlOracle(db, address)) {
      if (row.condition_id === null || row.token_id === null) continue;
      const totalBuyNotional = toNum(row.total_buy_notional) ?? 0;
      if (totalBuyNotional <= 0) continue;
      const realizedCash = toNum(row.realized_cash) ?? 0;
      const netShares = toNum(row.net_shares) ?? 0;
      const currentMarkUsdc = toNum(row.current_value_usdc) ?? 0;
      const marketOutcome =
        row.market_outcome === "winner" ||
        row.market_outcome === "loser" ||
        row.market_outcome === "unknown"
          ? row.market_outcome
          : null;
      const { pnlUsd, pnlPct, redemptionProceeds } = computeRealizedPnl({
        totalBuyNotional,
        realizedCash,
        currentMarkValue: currentMarkUsdc,
        netShares,
        marketOutcome,
      });
      expected.set(tokenPnlKey(row.condition_id, row.token_id), {
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
    expect(actual).toEqual(expected);
  }

  // 6. wave C: market-exposure per-(wallet, condition, token) fill rollups vs
  // preserved live-scan. Condition subset exercises the additive
  // `conditionIds` filter (cp3 excluded); the unknown address + duplicate
  // mixed-case address exercise resolution dedupe (legacy: no rows either).
  const rollupConditions = ["cp1", "cp2", "cp4"] as const;
  const rollupWallets = [
    TARGET_ADDRESS,
    COGNI_ADDRESS.toUpperCase(),
    COGNI_ADDRESS,
    "0xfe99fe99fe99fe99fe99fe99fe99fe99fe99fe99",
  ] as const;
  const actualRollups = await readFillRollups({
    db,
    conditions: rollupConditions,
    walletAddresses: rollupWallets,
  });
  const expectedRollups = new Map<string, FillRollup>();
  for (const row of await readMarketFillRollupsOracle(
    db,
    rollupConditions,
    rollupWallets
  )) {
    if (
      row.wallet_address === null ||
      row.condition_id === null ||
      row.token_id === null
    ) {
      continue;
    }
    expectedRollups.set(
      rollupKey(row.wallet_address, row.condition_id, row.token_id),
      {
        totalBuyNotional: toNum(row.total_buy_notional) ?? 0,
        realizedCash: toNum(row.realized_cash) ?? 0,
        netShares: toNum(row.net_shares) ?? 0,
        marketOutcome:
          row.market_outcome === "winner" ||
          row.market_outcome === "loser" ||
          row.market_outcome === "unknown"
            ? row.market_outcome
            : null,
      }
    );
  }
  expect(expectedRollups.size).toBeGreaterThan(0);
  expect(actualRollups).toEqual(expectedRollups);
}

describe("fill-rollup read parity (task.research-rollup-read-models)", () => {
  beforeAll(async () => {
    const db = getSeedDb();
    const inserted = await db
      .insert(polyTraderWallets)
      .values([
        { walletAddress: TARGET_ADDRESS, kind: "copy_target", label: "parity-target" },
        { walletAddress: COGNI_ADDRESS, kind: "cogni_wallet", label: "parity-cogni" },
      ])
      .returning({
        id: polyTraderWallets.id,
        walletAddress: polyTraderWallets.walletAddress,
      });
    targetId = inserted.find((w) => w.walletAddress === TARGET_ADDRESS)?.id ?? "";
    cogniId = inserted.find((w) => w.walletAddress === COGNI_ADDRESS)?.id ?? "";
    if (!targetId || !cogniId) throw new Error("failed to seed parity wallets");

    await seedFillBatch(FILLS, "rp");
    await db.insert(polyMarketOutcomes).values(
      OUTCOMES.map((o) => ({
        conditionId: o.conditionId,
        tokenId: o.tokenId,
        outcome: o.outcome,
      }))
    );
    // Live current positions: cp1 shared, cp2 target-only, cp4 cogni-only.
    const now = new Date();
    await db.insert(polyTraderCurrentPositions).values([
      { traderWalletId: targetId, conditionId: "cp1", tokenId: "tp1y", active: true, shares: "5", costBasisUsdc: "12.5", currentValueUsdc: "12.5", avgPrice: "0.5", contentHash: "rp-t1", lastObservedAt: now, firstObservedAt: now },
      { traderWalletId: targetId, conditionId: "cp2", tokenId: "tp2y", active: true, shares: "6", costBasisUsdc: "3", currentValueUsdc: "3.25", avgPrice: "0.5", contentHash: "rp-t2", lastObservedAt: now, firstObservedAt: now },
      { traderWalletId: cogniId, conditionId: "cp1", tokenId: "tp1y", active: true, shares: "4", costBasisUsdc: "2", currentValueUsdc: "2.25", avgPrice: "0.5", contentHash: "rp-c1", lastObservedAt: now, firstObservedAt: now },
      { traderWalletId: cogniId, conditionId: "cp4", tokenId: "tp4y", active: true, shares: "18", costBasisUsdc: "9", currentValueUsdc: "7.5", avgPrice: "0.5", contentHash: "rp-c4", lastObservedAt: now, firstObservedAt: now },
    ]);
  });

  afterAll(async () => {
    const db = getSeedDb();
    const walletIds = [targetId, cogniId].filter(Boolean);
    if (walletIds.length > 0) {
      await db
        .delete(polyTraderCurrentPositions)
        .where(inArray(polyTraderCurrentPositions.traderWalletId, walletIds));
      await db
        .delete(polyTraderFills)
        .where(inArray(polyTraderFills.traderWalletId, walletIds));
      // rollups + cursors cascade with the wallet rows
      await db
        .delete(polyTraderWallets)
        .where(inArray(polyTraderWallets.id, walletIds));
    }
    await db
      .delete(polyMarketOutcomes)
      .where(
        inArray(polyMarketOutcomes.conditionId, [
          ...new Set(OUTCOMES.map((o) => o.conditionId)),
          ...MIXED_CASE_OUTCOMES,
        ])
      );
  });

  it("cold state: no rollups — every reader serves the fill tail", async () => {
    await assertParity(FILLS);
  });

  it("partial state: some fills rolled, the rest tail", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const target = await accumulateFillRollups(db, {
      traderWalletId: targetId,
      batchSize: 3,
      maxBatches: 1,
    });
    expect(target.fills).toBe(3);
    expect(target.caughtUp).toBe(false);
    const cogni = await accumulateFillRollups(db, {
      traderWalletId: cogniId,
      batchSize: 2,
      maxBatches: 1,
    });
    expect(cogni.fills).toBe(2);
    await assertParity(FILLS);
  });

  it("warm state: fully accumulated", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const target = await accumulateFillRollups(db, { traderWalletId: targetId });
    const cogni = await accumulateFillRollups(db, { traderWalletId: cogniId });
    expect(target.caughtUp).toBe(true);
    expect(cogni.caughtUp).toBe(true);
    await assertParity(FILLS);
  });

  it("tail state: fresh fills on top of a warm rollup", async () => {
    await seedFillBatch(TAIL_FILLS, "rp-tail");
    await assertParity([...FILLS, ...TAIL_FILLS]);
  });

  it("joins resolved winners and applies payout across both condition-casing schedules", async () => {
    const db = getSeedDb();
    await db.insert(polyTraderFills).values([
      {
        traderWalletId: cogniId,
        source: "data-api",
        nativeId: "mixed-winner-a",
        conditionId: "CASE-WINNER-A",
        tokenId: "winner-a",
        side: "BUY",
        price: "0.5",
        shares: "2",
        sizeUsdc: "1",
        observedAt: new Date(),
      },
      {
        traderWalletId: cogniId,
        source: "data-api",
        nativeId: "mixed-winner-b",
        conditionId: "case-winner-b",
        tokenId: "winner-b",
        side: "BUY",
        price: "0.5",
        shares: "2",
        sizeUsdc: "1",
        observedAt: new Date(),
      },
    ]);
    await db.insert(polyMarketOutcomes).values([
      { conditionId: "case-winner-a", tokenId: "winner-a", outcome: "winner" },
      { conditionId: "CASE-WINNER-B", tokenId: "winner-b", outcome: "winner" },
    ]);

    const pnl = await readWalletTokenPnlMap({
      db: db as unknown as ServiceDb,
      walletAddress: COGNI_ADDRESS.toUpperCase(),
      positionKeys: [
        { conditionId: "case-winner-a", tokenId: "winner-a" },
        { conditionId: "CASE-WINNER-B", tokenId: "winner-b" },
      ],
    });
    const positions = [
      { conditionId: "case-winner-a", asset: "winner-a", pnlUsd: -1, pnlPct: -100 },
      { conditionId: "CASE-WINNER-B", asset: "winner-b", pnlUsd: -1, pnlPct: -100 },
    ] as WalletExecutionPosition[];

    expect(applyRealizedPnl(positions, pnl).map(({ pnlUsd, pnlPct }) => ({ pnlUsd, pnlPct }))).toEqual([
      { pnlUsd: 1, pnlPct: 100 },
      { pnlUsd: 1, pnlPct: 100 },
    ]);
  });
});
