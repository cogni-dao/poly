// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/hash-position`
 * Purpose: Prove the snapshot content hash covers only position-defining
 *          fields (task.5012) so mark-to-market drift no longer defeats the
 *          `onConflictDoNothing` dedupe on `poly_trader_position_snapshots`.
 * Scope: Pure-function tests for `hashPosition`. No DB, no I/O.
 * Invariants:
 *   - MARK_INVARIANT: positions differing only in `currentValue`/`curPrice`
 *     (or any other non-defining field) hash identically.
 *   - DEFINING_FIELDS_SENSITIVE: changing conditionId/asset/size/avgPrice/
 *     initialValue changes the hash.
 * Side-effects: none
 * Links: work/items/task.5012,
 *        src/features/wallet-analysis/server/trader-observation-service.ts
 * @public
 */

import type { PolymarketUserPosition } from "@cogni/poly-market-provider/adapters/polymarket";
import { describe, expect, it } from "vitest";
import { hashPosition } from "@/features/wallet-analysis/server/trader-observation-service";

function position(
  overrides: Partial<PolymarketUserPosition> = {}
): PolymarketUserPosition {
  return {
    proxyWallet: `0x${"a".repeat(40)}`,
    asset: "123456789",
    conditionId: `0x${"c".repeat(64)}`,
    size: 100,
    avgPrice: 0.42,
    initialValue: 42,
    currentValue: 55.5,
    cashPnl: 13.5,
    percentPnl: 32.14,
    totalBought: 42,
    realizedPnl: 0,
    percentRealizedPnl: 0,
    curPrice: 0.555,
    redeemable: false,
    mergeable: false,
    title: "Will it rain tomorrow?",
    slug: "will-it-rain-tomorrow",
    icon: "",
    eventId: "evt-1",
    eventSlug: "weather",
    outcome: "Yes",
    outcomeIndex: 0,
    oppositeOutcome: "No",
    oppositeAsset: "987654321",
    endDate: "2026-12-31",
    negativeRisk: false,
    ...overrides,
  };
}

describe("hashPosition (task.5012)", () => {
  it("is a stable 64-char sha256 hex digest", () => {
    const hash = hashPosition(position());
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPosition(position())).toBe(hash);
  });

  it("ignores mark-to-market fields: same hash when only currentValue/curPrice differ", () => {
    const base = hashPosition(position({ currentValue: 55.5, curPrice: 0.555 }));
    const moved = hashPosition(position({ currentValue: 12.3, curPrice: 0.123 }));
    expect(moved).toBe(base);
  });

  it("ignores other non-defining fields (cashPnl, percentPnl, title, redeemable)", () => {
    const base = hashPosition(position());
    const noisy = hashPosition(
      position({
        cashPnl: -99,
        percentPnl: -12.5,
        title: "Renamed market",
        redeemable: true,
      })
    );
    expect(noisy).toBe(base);
  });

  it("changes when size changes", () => {
    expect(hashPosition(position({ size: 101 }))).not.toBe(
      hashPosition(position({ size: 100 }))
    );
  });

  it("changes when any other position-defining field changes", () => {
    const base = hashPosition(position());
    expect(hashPosition(position({ avgPrice: 0.43 }))).not.toBe(base);
    expect(hashPosition(position({ initialValue: 43 }))).not.toBe(base);
    expect(hashPosition(position({ asset: "42" }))).not.toBe(base);
    expect(
      hashPosition(position({ conditionId: `0x${"d".repeat(64)}` }))
    ).not.toBe(base);
  });
});
