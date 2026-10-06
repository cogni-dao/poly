// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/capability-plane/portfolio-snapshot.fixture`
 * Purpose: One snapshot fixture that genuinely satisfies
 *   `PolyAccountPortfolioSnapshotOutputSchema`, so the tests around it exercise
 *   the executor's real output validation instead of a loosened stand-in.
 * Scope: Test data only.
 * Links: task.1791070962
 * @internal
 */

import type { PolyAccountPortfolioSnapshotOutput } from "@cogni/poly-node-contracts";

const CAPTURED_AT = "2026-10-06T12:00:00.000Z";
const ADDRESS = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

const freshMeta = {
  status: "fresh" as const,
  source: "local_ledger" as const,
  observedAt: CAPTURED_AT,
  ageMs: 0,
  complete: true,
};

const unavailableMeta = {
  status: "unavailable" as const,
  source: "polygon_balance_snapshot" as const,
  observedAt: null,
  ageMs: null,
  complete: false,
};

/** Satisfies the leaf superRefine: all counts present, consistent, complete. */
const coverageLeaf = {
  eligible: 0,
  comparable: 0,
  dropped: 0,
  sampled: 0,
  complete: true,
  reasons: [],
};

/**
 * A degraded-but-valid snapshot: cash is `unavailable`, so `usdc_available`
 * and `usdc_total` are null with a warning explaining why. That is the
 * NO_FABRICATED_VALUES shape the whole contract exists to protect, so it is
 * the right default fixture rather than an all-green one.
 */
export function portfolioSnapshotFixture(
  overrides: Partial<PolyAccountPortfolioSnapshotOutput> = {}
): PolyAccountPortfolioSnapshotOutput {
  return {
    snapshotId: "33333333-3333-4333-8333-333333333333",
    capturedAt: CAPTURED_AT,
    interval: "1W",
    readiness: {
      connected: true,
      funder_address: ADDRESS,
      trading_ready: true,
      auto_wrap_consent_at: null,
      auto_wrap_floor_usdce_atomic: "0",
      observedAt: CAPTURED_AT,
    },
    overview: {
      configured: true,
      connected: true,
      freshness: "read_model",
      address: ADDRESS,
      interval: "1W",
      capturedAt: CAPTURED_AT,
      pol_gas: null,
      usdc_available: null,
      usdc_locked: 5,
      usdc_positions_mtm: 4,
      usdc_total: null,
      open_orders: 2,
      positions_synced_at: CAPTURED_AT,
      positions_sync_age_ms: 0,
      positions_stale: false,
      pnlHistory: [{ ts: CAPTURED_AT, pnl: 1.25 }],
      warnings: [{ code: "balances_unavailable", message: "unavailable" }],
    },
    execution: {
      address: ADDRESS,
      freshness: "read_model",
      capturedAt: CAPTURED_AT,
      dailyTradeCounts: [{ day: "2026-10-06", n: 3 }],
      live_positions: [],
      live_position_count: 3,
      market_groups: [],
      closed_positions: [],
      closed_position_count: 7,
      comparisonCoverage: {
        markets: { live: coverageLeaf, closed: coverageLeaf },
        positions: { live: coverageLeaf, closed: coverageLeaf },
        positionClassifications: [],
      },
      warnings: [],
    },
    facts: {
      wallet: { ...freshMeta, source: "wallet_connection" },
      cash: unavailableMeta,
      orders: { ...freshMeta, authority: "provisional_local_ledger" },
      positions: {
        ...freshMeta,
        source: "data_api_current_positions",
        actionsAllowed: true,
        previewLimit: 500,
      },
      history: {
        ...freshMeta,
        authority: "provisional_local_ledger",
        previewLimit: 30,
      },
      pnl: { ...freshMeta, source: "user_pnl_snapshot" },
      activity: freshMeta,
      markets: { ...freshMeta, source: "composite" },
      total: { ...unavailableMeta, source: "composite" },
    },
    warnings: [
      { component: "cash", code: "balances_unavailable", message: "unavailable" },
      {
        component: "wallet",
        code: "wallet_total_unavailable",
        message: "Total is hidden until cash and positions agree.",
      },
    ],
    ...overrides,
  };
}
