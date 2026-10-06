// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/trader-comparison-assembly`
 * Purpose: Prove `assembleTraderComparison` — the cheap response assembly over
 *   per-wallet cached results (fix/comparison-per-wallet-cache): positional
 *   label re-stamping (LABELS_ARE_PRESENTATION), budget-degraded wallets
 *   dropped with their warnings merged, oldest contributing `capturedAt`
 *   reported, and a contract-valid response shape from mixed warm/cold inputs.
 * Scope: Unit — pure function over hand-built results. No Db, no cache.
 * Invariants under test: LABELS_ARE_PRESENTATION, PER_WALLET_UNIT
 *   (trader-comparison-service docstring), partial-failure-200 contract shape.
 * Side-effects: none.
 * Links: src/features/wallet-analysis/server/trader-comparison-service.ts
 * @internal
 */

import {
  PolyResearchTraderComparisonResponseSchema,
  type PolyResearchTraderComparisonTrader,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import {
  assembleTraderComparison,
  TRADER_COMPARISON_BUDGET_WARNING_CODE,
  type TraderComparisonWalletResult,
} from "@/features/wallet-analysis/server/trader-comparison-service";

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;
const SWISSTONY = "0x204f72f35326db932158cba6adff0b9a1da95e14" as const;

function trader(
  address: `0x${string}`,
  label: string
): PolyResearchTraderComparisonTrader {
  return {
    address,
    label,
    isObserved: false,
    traderKind: null,
    interval: "1W",
    observedSince: null,
    lastObservedAt: null,
    observationStatus: null,
    pnl: { usdc: null, history: [] },
    trades: {
      count: 0,
      buyCount: 0,
      sellCount: 0,
      notionalUsdc: 0,
      buyUsdc: 0,
      sellUsdc: 0,
      marketCount: 0,
    },
    tradeSizePnl: {
      bucketStep: 5,
      sampleBuyCount: 0,
      resolvedCount: 0,
      winCount: 0,
      lossCount: 0,
      flatCount: 0,
      pendingCount: 0,
      winRate: null,
      pnlUsdc: 0,
      buyUsdc: 0,
      hedgeBuyCount: 0,
      hedgeBuyUsdc: 0,
      // Contract requires exactly 20 buckets (p0-p5 ... p95-p100).
      buckets: Array.from({ length: 20 }, (_, index) => {
        const lo = index * 5;
        const hi = lo + 5;
        return {
          key: `p${lo}_p${hi}`,
          label: `p${lo}-p${hi}`,
          loPercentile: lo,
          hiPercentile: hi,
          minSizeUsdc: 0,
          maxSizeUsdc: 0,
          avgSizeUsdc: 0,
          buyCount: 0,
          resolvedCount: 0,
          winCount: 0,
          lossCount: 0,
          flatCount: 0,
          pendingCount: 0,
          winRate: null,
          pnlUsdc: 0,
          buyUsdc: 0,
          hedgeBuyCount: 0,
          hedgeBuyUsdc: 0,
        };
      }),
    },
  };
}

function okResult(
  address: `0x${string}`,
  computedLabel: string,
  capturedAt: string
): TraderComparisonWalletResult {
  return {
    address,
    capturedAt,
    trader: trader(address, computedLabel),
    warnings: [],
  };
}

function degradedResult(
  address: `0x${string}`,
  capturedAt: string
): TraderComparisonWalletResult {
  return {
    address,
    capturedAt,
    trader: null,
    warnings: [
      {
        wallet: address,
        code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
        message: "budget exceeded",
      },
    ],
  };
}

describe("assembleTraderComparison", () => {
  it("re-stamps requested labels positionally; blank/missing labels keep the computed label", () => {
    const response = assembleTraderComparison(
      "1W",
      [
        { address: RN1, label: "My RN1" },
        { address: SWISSTONY, label: "   " },
      ],
      [
        okResult(RN1, "stored-label", "2026-10-05T00:00:00.000Z"),
        okResult(SWISSTONY, "0x204f...5e14", "2026-10-05T00:00:01.000Z"),
      ]
    );
    expect(response.traders.map((t) => t.label)).toEqual([
      "My RN1",
      "0x204f...5e14",
    ]);
    // Re-stamping only touches `label` — the rest of the trader is the cached value.
    expect(response.traders[0]?.address).toBe(RN1);
  });

  it("drops budget-degraded wallets, merges their warnings, keeps input order", () => {
    const response = assembleTraderComparison(
      "1W",
      [
        { address: RN1, label: "RN1" },
        { address: SWISSTONY, label: "swisstony" },
      ],
      [
        degradedResult(RN1, "2026-10-05T00:00:00.000Z"),
        okResult(SWISSTONY, "swisstony", "2026-10-05T00:00:01.000Z"),
      ]
    );
    expect(response.traders.map((t) => t.address)).toEqual([SWISSTONY]);
    expect(response.warnings).toContainEqual(
      expect.objectContaining({
        wallet: RN1,
        code: TRADER_COMPARISON_BUDGET_WARNING_CODE,
      })
    );
    expect(() =>
      PolyResearchTraderComparisonResponseSchema.parse(response)
    ).not.toThrow();
  });

  it("reports the OLDEST contributing capturedAt — honest about mixed warm/cold staleness", () => {
    const older = "2026-10-05T00:00:00.000Z";
    const newer = "2026-10-05T00:04:00.000Z";
    const response = assembleTraderComparison(
      "1W",
      [{ address: RN1 }, { address: SWISSTONY }],
      [okResult(RN1, "a", newer), okResult(SWISSTONY, "b", older)]
    );
    expect(response.capturedAt).toBe(older);
  });

  it("empty input assembles an empty, contract-valid response", () => {
    const response = assembleTraderComparison("1W", [], []);
    expect(response.traders).toEqual([]);
    expect(response.warnings).toEqual([]);
    expect(() =>
      PolyResearchTraderComparisonResponseSchema.parse(response)
    ).not.toThrow();
  });
});
