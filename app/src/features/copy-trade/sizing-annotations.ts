// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/sizing-annotations`
 * Purpose: Pure mapping from a resolved `SizingPolicy` (+ optional source snapshot for richer context) → a typed list of chart annotations the renderer can draw. Lets research tooling visualize the decision surface of *whichever* sizing policy is active, without the renderer knowing what pXX means.
 * Scope: Pure data emission. No I/O. No rendering. No SVG. The renderer (`scripts/poly-mirror-report.ts`) consumes `ChartAnnotation[]` and decides geometry.
 * Invariants:
 *   - ANNOTATION_KINDS_DISCRIMINATED — `ChartAnnotation` is a discriminated union on `kind`. New policy needs a new annotation shape → add a variant, switch arm in `annotationsForSizingPolicy`, and a draw case in the renderer.
 *   - SIDE_IS_EXPLICIT — every annotation declares which chart half it belongs on (`primary` upper / `hedge` lower). The renderer never guesses.
 *   - EMPHASIS_IS_DECLARATIVE — `emphasis: "primary" | "secondary"` lets the policy mark the *active* threshold without the renderer knowing the configured percentile.
 *   - POLICY_OWNS_ITS_ANNOTATIONS — the emitter that knows what to show for a policy lives in the same package as the policy. When copy-trade extracts to a shared package, the visualizer contract travels with it.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md
 * @public
 */

import type { WalletSizeSnapshot } from "./target-percentile-snapshots";
import type { SizingPolicy } from "./types";

/**
 * Horizontal cost-basis threshold (e.g. pXX) drawn on the chart's upper or lower
 * half via the renderer's symlog y-axis. `value_usdc` is mapped through the
 * same `ySide()` used for position lines, so a $146 threshold lands on the
 * same y as a $146 position datapoint.
 */
export interface HorizontalThresholdAnnotation {
  kind: "h_threshold";
  side: "primary" | "hedge";
  value_usdc: number;
  label: string;
  emphasis: "primary" | "secondary";
}

// Future annotation kinds plug in here. Examples (not yet implemented):
//   | { kind: "h_band"; side; lo_usdc; hi_usdc; label }
//   | { kind: "v_marker"; t_ms; label; color? }
// Add a variant + a switch arm in `annotationsForSizingPolicy` + a draw
// case in `scripts/poly-mirror-report.ts:svgTimeline()`.
export type ChartAnnotation = HorizontalThresholdAnnotation;

export interface SizingPolicyAnnotationContext {
  /** Optional source snapshot — when present, percentile policies emit the full ladder; when absent, they fall back to just (active, p99). */
  snapshot?: WalletSizeSnapshot | undefined;
}

/**
 * Map a resolved `SizingPolicy` to the annotations a chart should overlay.
 * Empty array is a valid result (e.g. `min_bet` has no thresholds to draw —
 * the chart renders unchanged, no special-casing needed in the renderer).
 */
export function annotationsForSizingPolicy(
  policy: SizingPolicy,
  ctx: SizingPolicyAnnotationContext = {}
): ChartAnnotation[] {
  switch (policy.kind) {
    case "min_bet":
    case "position_gap":
    case "mirror_fill_exact":
      // position_gap's decision surface is `target_shares × target_scale`,
      // not a static cost-basis ladder. mirror_fill_exact has no decision
      // surface — every fill is its own size. The renderer reads the actual
      // desired and actual share counts off the timeline series instead.
      return [];
    case "target_percentile":
    case "target_percentile_scaled":
      return ladderForPercentilePolicy(
        policy.statistic.percentile,
        policy.statistic.min_target_usdc,
        policy.statistic.max_target_usdc,
        ctx.snapshot
      );
  }
}

function ladderForPercentilePolicy(
  activePercentile: number,
  activeValueUsdc: number,
  p99ValueUsdc: number,
  snapshot: WalletSizeSnapshot | undefined
): ChartAnnotation[] {
  const points = snapshotLadderPoints(snapshot) ?? [
    { p: activePercentile, value: activeValueUsdc },
    { p: 99, value: p99ValueUsdc },
  ];
  const activeOnGrid = points.some((pt) => pt.p === activePercentile);
  const out: ChartAnnotation[] = points.map((pt) => ({
    kind: "h_threshold",
    side: "primary",
    value_usdc: pt.value,
    label: `p${pt.p} · $${formatUsdc(pt.value)}`,
    emphasis: pt.p === activePercentile ? "primary" : "secondary",
  }));
  if (!activeOnGrid) {
    out.push({
      kind: "h_threshold",
      side: "primary",
      value_usdc: activeValueUsdc,
      label: `p${activePercentile} · $${formatUsdc(activeValueUsdc)}`,
      emphasis: "primary",
    });
  }
  return out;
}

function snapshotLadderPoints(
  snapshot: WalletSizeSnapshot | undefined
): Array<{ p: number; value: number }> | undefined {
  if (!snapshot) return undefined;
  const entries = Object.entries(snapshot.percentiles)
    .map(([k, v]) => ({ p: Number(k), value: v }))
    .filter((e) => Number.isFinite(e.p) && Number.isFinite(e.value))
    .sort((a, b) => a.p - b.p);
  return entries.length > 0 ? entries : undefined;
}

function formatUsdc(v: number): string {
  if (v >= 1000) return `${Math.round(v / 100) / 10}k`;
  return v >= 100 ? Math.round(v).toString() : v.toFixed(0);
}
