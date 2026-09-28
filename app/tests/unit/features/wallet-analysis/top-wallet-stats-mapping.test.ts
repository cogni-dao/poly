// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/top-wallet-stats-mapping`
 * Purpose: Unit coverage for the pure leaderboard-entry → `poly_top_wallet_stats`
 *   row mapping the bug.5017 observation tick persists — rank parsing +
 *   fallback, roiPct derivation/clamp, numTradesCapped, userName handling,
 *   and rejection of malformed wallet addresses.
 * Scope: Pure-function tests; the tick's upsert/prune behaviour and the DB
 *   reader are proven by the component test
 *   (`tests/component/db/top-wallet-stats.int.test.ts`).
 * Invariants: Mapping preserves the exact `WalletTopTraderItem` semantics the
 *   pre-bug.5017 render-path fan-out produced.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/top-wallet-stats-service.ts,
 *   work/items/bug.5017
 * @public
 */

import type { PolymarketLeaderboardEntry } from "@cogni/poly-market-provider/adapters/polymarket";
import { describe, expect, it } from "vitest";
import { mapLeaderboardEntryToRow, isUpstreamRateLimit } from "@/features/wallet-analysis/server/top-wallet-stats-service";

const WALLET = `0x${"ab".repeat(20)}`;
const CAPTURED_AT = new Date("2026-09-26T00:00:00Z");

function entry(
  partial: Partial<PolymarketLeaderboardEntry>
): PolymarketLeaderboardEntry {
  return {
    rank: "1",
    proxyWallet: WALLET,
    userName: "trader-one",
    xUsername: "",
    verifiedBadge: false,
    vol: 1000,
    pnl: 250,
    profileImage: "",
    ...partial,
  };
}

function map(
  e: PolymarketLeaderboardEntry,
  overrides?: { index?: number; numTrades?: number }
) {
  return mapLeaderboardEntryToRow({
    entry: e,
    index: overrides?.index ?? 0,
    timePeriod: "WEEK",
    orderBy: "PNL",
    numTrades: overrides?.numTrades ?? 42,
    capturedAt: CAPTURED_AT,
  });
}

describe("mapLeaderboardEntryToRow", () => {
  it("maps a well-formed entry to a full row", () => {
    const row = map(entry({}));
    expect(row).toEqual({
      timePeriod: "WEEK",
      orderBy: "PNL",
      walletAddress: WALLET,
      rank: 1,
      userName: "trader-one",
      volumeUsdc: "1000",
      pnlUsdc: "250",
      roiPct: "25",
      numTrades: 42,
      numTradesCapped: false,
      verified: false,
      raw: entry({}),
      capturedAt: CAPTURED_AT,
    });
  });

  it("parses string rank; falls back to index+1 when unparsable or non-positive", () => {
    expect(map(entry({ rank: "17" }))?.rank).toBe(17);
    expect(map(entry({ rank: "not-a-rank" }), { index: 4 })?.rank).toBe(5);
    expect(map(entry({ rank: "0" }), { index: 9 })?.rank).toBe(10);
  });

  it("derives roiPct = pnl/vol*100 and returns null on zero volume (redemption-only rows)", () => {
    expect(map(entry({ vol: 200, pnl: -50 }))?.roiPct).toBe("-25");
    expect(map(entry({ vol: 0, pnl: 100 }))?.roiPct).toBeNull();
  });

  it("clamps pathological roiPct so a row cannot overflow numeric(18,8)", () => {
    const row = map(entry({ vol: 1e-6, pnl: 1e9 }));
    expect(Number(row?.roiPct)).toBe(1_000_000_000);
    const negative = map(entry({ vol: 1e-6, pnl: -1e9 }));
    expect(Number(negative?.roiPct)).toBe(-1_000_000_000);
  });

  it("flags numTradesCapped at the 500-row /trades ceiling", () => {
    expect(map(entry({}), { numTrades: 499 })?.numTradesCapped).toBe(false);
    expect(map(entry({}), { numTrades: 500 })?.numTradesCapped).toBe(true);
    expect(map(entry({}), { numTrades: 500 })?.numTrades).toBe(500);
  });

  it("persists empty userName for null/empty vendor values (reader falls back to address)", () => {
    expect(map(entry({ userName: null }))?.userName).toBe("");
    expect(map(entry({ userName: "" }))?.userName).toBe("");
  });

  it("rejects entries whose proxyWallet fails the address-shape check", () => {
    expect(map(entry({ proxyWallet: "not-a-wallet" }))).toBeNull();
    expect(map(entry({ proxyWallet: `0x${"ab".repeat(19)}` }))).toBeNull();
    expect(map(entry({ proxyWallet: WALLET.toUpperCase() }))).toBeNull();
  });

  it("preserves the full vendor payload in raw", () => {
    const e = entry({ xUsername: "xhandle", profileImage: "http://img" });
    expect(map(e)?.raw).toEqual(e);
  });
});

describe("isUpstreamRateLimit (bug.5283)", () => {
  it("recognises the verbatim production 429 message", () => {
    // Exact string prod logged 10 times in the SAME second (05:37:31) while the
    // fan-out kept draining into the limit. If this stops matching, the circuit
    // breaker silently stops breaking and we resume burning Polymarket's budget.
    expect(
      isUpstreamRateLimit(
        "Polymarket Data API error: 429 Too Many Requests (/trades)"
      )
    ).toBe(true);
  });

  it("matches the textual form too", () => {
    expect(isUpstreamRateLimit("Too Many Requests")).toBe(true);
    expect(isUpstreamRateLimit("too many requests")).toBe(true);
  });

  it("does NOT trip on unrelated failures", () => {
    // A false positive only costs one cycle of enrichment freshness, but it
    // should still not fire for ordinary errors — otherwise one flaky wallet
    // silently disables enrichment for the whole run.
    expect(isUpstreamRateLimit("fetch failed")).toBe(false);
    expect(isUpstreamRateLimit("Polymarket Data API error: 500")).toBe(false);
    expect(isUpstreamRateLimit("timeout after 5000ms")).toBe(false);
  });

  it("does not trip on a 429 embedded in a larger number", () => {
    expect(isUpstreamRateLimit("wallet 0x4290 returned 503")).toBe(false);
  });
});
