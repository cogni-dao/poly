// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/trade-size-pnl-bucket-mapping`
 * Purpose: Unit coverage for the V8-side tail of the bug.5008 SQL rewrite — the mapping from
 *   SQL bucket rows (≤20, the only rows that ever reach V8) to the fixed 20-bucket contract
 *   shape, including finalize rounding, winRate, and the rounded-bucket totals reduction.
 * Scope: Pure-function tests; the SQL itself is proven by the component parity test
 *   (`tests/component/db/trader-comparison-sql-parity.int.test.ts`).
 * Invariants: Output always parses against `PolyResearchTraderSizePnlSchema`.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/trader-comparison-service.ts, work/items/bug.5008
 * @public
 */

import { PolyResearchTraderSizePnlSchema } from "@cogni/poly-node-contracts";
import { emptyTradeSizePnl as oracleEmptyTradeSizePnl } from "@tests/_fixtures/poly/trade-size-pnl-oracle";
import { describe, expect, it } from "vitest";
import {
  buildTradeSizePnlFromBucketRows,
  type TradeSizePnlBucketRow,
} from "@/features/wallet-analysis/server/trader-comparison-service";

function row(partial: Partial<TradeSizePnlBucketRow>): TradeSizePnlBucketRow {
  return {
    bucket_index: 0,
    buy_count: 0,
    buy_usdc: "0",
    min_size_usdc: "0",
    max_size_usdc: "0",
    hedge_buy_count: 0,
    hedge_buy_usdc: "0",
    pending_count: 0,
    resolved_count: 0,
    pnl_usdc: "0",
    win_count: 0,
    loss_count: 0,
    flat_count: 0,
    ...partial,
  };
}

describe("buildTradeSizePnlFromBucketRows (bug.5008)", () => {
  it("zero rows produces the exact legacy empty shape", () => {
    const result = buildTradeSizePnlFromBucketRows([]);
    expect(result).toEqual(oracleEmptyTradeSizePnl());
    expect(() => PolyResearchTraderSizePnlSchema.parse(result)).not.toThrow();
  });

  it("maps numeric-string SQL values, computes avg/winRate, and totals rounded buckets", () => {
    const result = buildTradeSizePnlFromBucketRows([
      row({
        bucket_index: 3,
        buy_count: 2,
        buy_usdc: "10.5",
        min_size_usdc: "4.5",
        max_size_usdc: "6",
        hedge_buy_count: 1,
        hedge_buy_usdc: "4.5",
        pending_count: 1,
        resolved_count: 1,
        pnl_usdc: "0.75",
        win_count: 1,
        loss_count: 0,
        flat_count: 0,
      }),
      row({
        bucket_index: 19,
        buy_count: 1,
        buy_usdc: "100",
        min_size_usdc: "100",
        max_size_usdc: "100",
        resolved_count: 1,
        pnl_usdc: "-2.25",
        loss_count: 1,
      }),
    ]);

    const bucket3 = result.buckets[3];
    expect(bucket3).toMatchObject({
      key: "p15_p20",
      buyCount: 2,
      buyUsdc: 10.5,
      avgSizeUsdc: 5.25,
      minSizeUsdc: 4.5,
      maxSizeUsdc: 6,
      hedgeBuyCount: 1,
      hedgeBuyUsdc: 4.5,
      pendingCount: 1,
      resolvedCount: 1,
      pnlUsdc: 0.75,
      winCount: 1,
      winRate: 1,
    });
    const bucket19 = result.buckets[19];
    expect(bucket19).toMatchObject({
      buyCount: 1,
      pnlUsdc: -2.25,
      lossCount: 1,
      winRate: 0,
    });
    // untouched bucket stays empty with null winRate
    expect(result.buckets[0]).toMatchObject({ buyCount: 0, winRate: null });

    expect(result).toMatchObject({
      bucketStep: 5,
      sampleBuyCount: 3,
      resolvedCount: 2,
      winCount: 1,
      lossCount: 1,
      flatCount: 0,
      pendingCount: 1,
      pnlUsdc: -1.5,
      buyUsdc: 110.5,
      hedgeBuyCount: 1,
      hedgeBuyUsdc: 4.5,
      winRate: 0.5,
    });
    expect(result.buckets).toHaveLength(20);
    expect(() => PolyResearchTraderSizePnlSchema.parse(result)).not.toThrow();
  });

  it("ignores out-of-range bucket indexes defensively", () => {
    const result = buildTradeSizePnlFromBucketRows([
      row({ bucket_index: 25, buy_count: 4, buy_usdc: "9" }),
    ]);
    expect(result.sampleBuyCount).toBe(0);
    expect(() => PolyResearchTraderSizePnlSchema.parse(result)).not.toThrow();
  });
});
