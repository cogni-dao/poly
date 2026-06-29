// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/target-percentile-snapshots`
 * Purpose: Pure source-of-truth for the hardcoded per-target position-size percentile snapshots that drive `target_percentile` / `target_percentile_scaled` sizing policies. Bootstrap consumes these to build `MirrorTargetConfig.sizing.statistic`; research tooling (delta-minimizer report) consumes them to overlay pXX thresholds on charts.
 * Scope: Data + pure interpolation only. No I/O, no env reads, no DB.
 * Invariants:
 *   - ONE_SOURCE_OF_TRUTH_FOR_PXX — every consumer of pXX thresholds (bootstrap, research, future visualizers) imports from this module. No parallel snapshot tables.
 *   - SNAPSHOT_IS_FROZEN_PER_TARGET — `captured_at` is the one-time capture date; consumers MUST surface it so stale-data risk is visible. When snapshots become dynamic, persist them on `poly_copy_trade_decisions` (separate change).
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md, work/charters/POLY_COPY_DELTA.md
 * @public
 */

import type { WalletSizeStatistic } from "./types";

export interface WalletSizeSnapshot {
  wallet: `0x${string}`;
  label: string;
  captured_at: string;
  sample_size: number;
  percentiles: Record<number, number>;
}

const RN1_WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const SWISSTONY_WALLET = "0x204f72f35326db932158cba6adff0b9a1da95e14";

// Snapshots calibrated to PRIMARY-side cumulative cost per (condition, token)
// over the last 30 days of prod activity. The dominance gate
// (`target_dominant_other_side`, min_target_side_fraction=0.2) already filters
// hedge-side fills before sizing runs, so the percentiles here are computed
// on dominant-side positions only — that's the distribution `bet-sizer-v1`
// effectively sees per decision.
//
// Source query: docs/research/poly/queries/q15-past-month-pXX-primary-vs-hedge.sql
// Methodology + cross-validation: docs/research/poly/copy-target-north-star-2026-05-16.md
// Recipe for re-calibration: .claude/skills/data-research/recipes/copy-target-pXX-calibration.md
// Prior snapshot (2026-05-03, mixed primary+hedge) was 2-3× too low at p75/p90
// because hedge tokens deflated the low-end percentiles.
export const TOP_TARGET_SIZE_SNAPSHOTS: Record<string, WalletSizeSnapshot> = {
  [RN1_WALLET]: {
    wallet: RN1_WALLET,
    label: "RN1",
    captured_at: "2026-05-17T02:00:00Z",
    sample_size: 4486,
    percentiles: {
      50: 955,
      75: 3253,
      90: 8855,
      95: 14514,
      99: 30901,
    },
  },
  [SWISSTONY_WALLET]: {
    wallet: SWISSTONY_WALLET,
    label: "swisstony",
    captured_at: "2026-05-17T02:00:00Z",
    sample_size: 7414,
    percentiles: {
      50: 498,
      75: 1767,
      90: 5290,
      95: 10576,
      99: 28413,
    },
  },
};

export function snapshotForTargetWallet(
  targetWallet: `0x${string}`
): WalletSizeSnapshot | undefined {
  return TOP_TARGET_SIZE_SNAPSHOTS[targetWallet.toLowerCase()];
}

export function interpolatePercentile(
  percentiles: Record<number, number>,
  percentile: number
): number {
  const points = Object.keys(percentiles)
    .map(Number)
    .sort((a, b) => a - b);
  const exact = percentiles[percentile];
  if (exact !== undefined) return exact;
  const lower = [...points].reverse().find((p) => p < percentile);
  const upper = points.find((p) => p > percentile);
  if (lower === undefined) {
    const minPoint = points[0];
    if (minPoint === undefined) {
      throw new Error("percentile snapshot is empty");
    }
    return percentiles[minPoint] ?? 0;
  }
  if (upper === undefined) {
    const maxPoint = points.at(-1);
    if (maxPoint === undefined) {
      throw new Error("percentile snapshot is empty");
    }
    return percentiles[maxPoint] ?? 0;
  }
  const lowerValue = percentiles[lower];
  const upperValue = percentiles[upper];
  if (lowerValue === undefined || upperValue === undefined) {
    throw new Error("percentile snapshot is sparse");
  }
  const t = (percentile - lower) / (upper - lower);
  return Number((lowerValue + (upperValue - lowerValue) * t).toFixed(2));
}

export function buildWalletStatistic(
  snapshot: WalletSizeSnapshot,
  percentile: number
): WalletSizeStatistic {
  const maxTargetUsdc = snapshot.percentiles[99];
  if (maxTargetUsdc === undefined) {
    throw new Error(`missing p99 for ${snapshot.wallet}`);
  }
  return {
    wallet: snapshot.wallet,
    label: snapshot.label,
    captured_at: snapshot.captured_at,
    sample_size: snapshot.sample_size,
    percentile,
    min_target_usdc: interpolatePercentile(snapshot.percentiles, percentile),
    max_target_usdc: maxTargetUsdc,
  };
}
