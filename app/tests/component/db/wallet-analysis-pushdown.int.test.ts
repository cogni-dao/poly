// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/wallet-analysis-pushdown.int.test`
 * Purpose: Prove the task.5018 tenant-filter pushdowns are pure predicate
 *          pushdowns — results for wallet A are byte-identical whether or not
 *          unrelated wallet X has rows in the scanned tables.
 * Scope: DB-backed tests for `getBenchmarkSlice` (readSummary + readActiveGaps
 *        CTE wallet filters) and `getTradingWalletPnlHistory` (ts >= window
 *        bound pushed into SQL). Does not test routes or RLS.
 * Invariants:
 *   - CROSS_TENANT_INDEPENDENCE: inserting another wallet's positions/fills/
 *     pnl points does not change the requested wallet's slice output.
 *   - WINDOW_PARITY: SQL-windowed pnl history equals the JS `filterPnlHistory`
 *     expectation for windowed intervals; ALL applies no bound.
 * Side-effects: IO (database operations via testcontainers)
 * Links: work/items/task.5018,
 *        src/features/wallet-analysis/server/copy-target-benchmark-service.ts,
 *        src/features/wallet-analysis/server/trading-wallet-overview-service.ts
 * @public
 */

import {
  polyTraderCurrentPositions,
  polyTraderFills,
  polyTraderUserPnlPoints,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBenchmarkSlice } from "@/features/wallet-analysis/server/copy-target-benchmark-service";
import { getTradingWalletPnlHistory } from "@/features/wallet-analysis/server/trading-wallet-overview-service";

const TARGET_ADDR = `0x${"a".repeat(40)}` as const;
const COGNI_ADDR = `0x${"b".repeat(40)}` as const;
const OTHER_ADDR = `0x${"c".repeat(40)}` as const;

const DAY_MS = 86_400_000;
/** Whole-second anchor so JS floor-to-second and SQL timestamptz agree. */
const NOW = new Date(Math.floor(Date.now() / 1_000) * 1_000);

let targetId: string;
let cogniId: string;
let otherId: string;

function position(input: {
  traderWalletId: string;
  conditionId: string;
  tokenId: string;
  shares: string;
  costBasisUsdc: string;
  currentValueUsdc: string;
}) {
  return {
    ...input,
    active: true,
    avgPrice: "0.50000000",
    contentHash: `hash-${input.traderWalletId}-${input.conditionId}-${input.tokenId}`,
    lastObservedAt: NOW,
    firstObservedAt: NOW,
  };
}

function fill(input: {
  traderWalletId: string;
  nativeId: string;
  conditionId: string;
  tokenId: string;
  shares: string;
  sizeUsdc: string;
}) {
  return {
    ...input,
    source: "data-api" as const,
    side: "BUY" as const,
    price: "0.50000000",
    observedAt: NOW,
  };
}

describe("wallet-analysis tenant-filter pushdown (task.5018)", () => {
  const db = getSeedDb();

  beforeAll(async () => {
    const wallets = await db
      .insert(polyTraderWallets)
      .values([
        { walletAddress: TARGET_ADDR, kind: "copy_target", label: "target" },
        { walletAddress: COGNI_ADDR, kind: "cogni_wallet", label: "cogni" },
        { walletAddress: OTHER_ADDR, kind: "copy_target", label: "other" },
      ])
      .returning({
        id: polyTraderWallets.id,
        walletAddress: polyTraderWallets.walletAddress,
      });
    const byAddr = new Map(wallets.map((w) => [w.walletAddress, w.id]));
    targetId = byAddr.get(TARGET_ADDR) as string;
    cogniId = byAddr.get(COGNI_ADDR) as string;
    otherId = byAddr.get(OTHER_ADDR) as string;

    await db.insert(polyTraderCurrentPositions).values([
      // target: cond1 is an active gap (cogni < 1), cond2 is covered (cogni >= 1)
      position({
        traderWalletId: targetId,
        conditionId: "cond1",
        tokenId: "tokA",
        shares: "40",
        costBasisUsdc: "10",
        currentValueUsdc: "20",
      }),
      position({
        traderWalletId: targetId,
        conditionId: "cond2",
        tokenId: "tokB",
        shares: "14",
        costBasisUsdc: "6",
        currentValueUsdc: "7",
      }),
      position({
        traderWalletId: cogniId,
        conditionId: "cond1",
        tokenId: "tokA",
        shares: "1",
        costBasisUsdc: "0.4",
        currentValueUsdc: "0.5",
      }),
      position({
        traderWalletId: cogniId,
        conditionId: "cond2",
        tokenId: "tokB",
        shares: "4",
        costBasisUsdc: "1.5",
        currentValueUsdc: "2",
      }),
    ]);

    await db.insert(polyTraderFills).values([
      fill({
        traderWalletId: targetId,
        nativeId: "t-1",
        conditionId: "cond1",
        tokenId: "tokA",
        shares: "10",
        sizeUsdc: "6",
      }),
      fill({
        traderWalletId: targetId,
        nativeId: "t-2",
        conditionId: "cond2",
        tokenId: "tokB",
        shares: "8",
        sizeUsdc: "4",
      }),
      fill({
        traderWalletId: cogniId,
        nativeId: "c-1",
        conditionId: "cond1",
        tokenId: "tokA",
        shares: "5",
        sizeUsdc: "3",
      }),
    ]);

    await db.insert(polyTraderUserPnlPoints).values(
      [60, 10, 1].map((daysAgo) => ({
        traderWalletId: targetId,
        fidelity: "1d",
        ts: new Date(NOW.getTime() - daysAgo * DAY_MS),
        pnlUsdc: `${100 - daysAgo}.00000000`,
      }))
    );
  });

  afterAll(async () => {
    // FK cascade removes positions, fills, and pnl points.
    await db
      .delete(polyTraderWallets)
      .where(
        inArray(polyTraderWallets.walletAddress, [
          TARGET_ADDR,
          COGNI_ADDR,
          OTHER_ADDR,
        ])
      );
  });

  /** Insert the unrelated wallet's rows — the cross-tenant noise the pushdown
   * must not let into target/cogni aggregates. Overlaps cond1/tokA on purpose. */
  async function seedOtherWalletNoise(): Promise<void> {
    await db.insert(polyTraderCurrentPositions).values([
      position({
        traderWalletId: otherId,
        conditionId: "cond1",
        tokenId: "tokA",
        shares: "1000",
        costBasisUsdc: "400",
        currentValueUsdc: "500",
      }),
      position({
        traderWalletId: otherId,
        conditionId: "cond3",
        tokenId: "tokC",
        shares: "300",
        costBasisUsdc: "90",
        currentValueUsdc: "120",
      }),
    ]);
    await db.insert(polyTraderFills).values([
      fill({
        traderWalletId: otherId,
        nativeId: "x-1",
        conditionId: "cond1",
        tokenId: "tokA",
        shares: "200",
        sizeUsdc: "100",
      }),
    ]);
    await db.insert(polyTraderUserPnlPoints).values(
      [60, 10, 1].map((daysAgo) => ({
        traderWalletId: otherId,
        fidelity: "1d",
        ts: new Date(NOW.getTime() - daysAgo * DAY_MS),
        pnlUsdc: "-999.00000000",
      }))
    );
  }

  it("benchmark slice is byte-identical with and without another wallet's rows", async () => {
    const before = await getBenchmarkSlice(db, TARGET_ADDR, "ALL", {
      comparisonWalletAddress: COGNI_ADDR,
    });
    await seedOtherWalletNoise();
    const after = await getBenchmarkSlice(db, TARGET_ADDR, "ALL", {
      comparisonWalletAddress: COGNI_ADDR,
    });

    expect(before.kind).toBe("ok");
    expect(after.kind).toBe("ok");
    if (before.kind !== "ok" || after.kind !== "ok") return;

    // computedAt is wall-clock; everything else must match exactly.
    const { computedAt: _b, ...beforeRest } = before.value;
    const { computedAt: _a, ...afterRest } = after.value;
    expect(afterRest).toEqual(beforeRest);

    // Fixture-derived expectations pin the semantics (not just stability).
    expect(afterRest.coverage.targetTrades).toBe(2);
    expect(afterRest.coverage.cogniTrades).toBe(1);
    expect(afterRest.summary.targetOpenValueUsdc).toBe(27);
    expect(afterRest.summary.cogniOpenValueUsdc).toBe(2.5);
    expect(afterRest.summary.targetSizeUsdc).toBe(10);
    expect(afterRest.summary.cogniSizeUsdc).toBe(3);
    expect(afterRest.activeGaps).toEqual([
      {
        conditionId: "cond1",
        tokenId: "tokA",
        targetCurrentValueUsdc: 20,
        reason: "no_matching_cogni_position",
      },
    ]);
  });

  it("null comparison wallet still returns the target-only slice", async () => {
    const slice = await getBenchmarkSlice(db, TARGET_ADDR, "ALL", {});
    expect(slice.kind).toBe("ok");
    if (slice.kind !== "ok") return;
    expect(slice.value.summary.targetOpenValueUsdc).toBe(27);
    expect(slice.value.summary.cogniOpenValueUsdc).toBe(0);
    expect(slice.value.coverage.cogniTrades).toBe(0);
    // Without a cogni wallet, every target position >= $5 is a gap.
    expect(slice.value.activeGaps.map((gap) => gap.conditionId).sort()).toEqual(
      ["cond1", "cond2"]
    );
  });

  it("pnl history 1M window returns only rows inside the JS cutoff", async () => {
    const capturedAt = NOW.toISOString();
    const history = await getTradingWalletPnlHistory({
      db,
      address: TARGET_ADDR,
      interval: "1M",
      capturedAt,
    });
    // 60d-old point is outside the 30d window; 10d and 1d remain, ascending.
    expect(history).toEqual([
      {
        ts: new Date(NOW.getTime() - 10 * DAY_MS).toISOString(),
        pnl: 90,
      },
      {
        ts: new Date(NOW.getTime() - 1 * DAY_MS).toISOString(),
        pnl: 99,
      },
    ]);
  });

  it("pnl history ALL applies no bound and returns the full series", async () => {
    const history = await getTradingWalletPnlHistory({
      db,
      address: TARGET_ADDR,
      interval: "ALL",
      capturedAt: NOW.toISOString(),
    });
    expect(history.map((point) => point.pnl)).toEqual([40, 90, 99]);
  });
});
