// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/position-cost`
 * Purpose: Pure helper to coerce a Polymarket Data-API position record into a
 *          cost-basis USDC number. Shared by the per-condition position view
 *          builder (`copy-trade-mirror.job.ts::targetConditionPositionFromDataApiPositions`)
 *          and the whole-book Σ hydrator in the bootstrap container, so both
 *          consumers agree on how `initialValue` / `size × avgPrice` map to
 *          a single cost-basis number.
 * Scope: Pure function. No I/O, no env reads, no DB.
 * Invariants:
 *   - PREFER_INITIAL_VALUE — when `initialValue` is finite + positive, return
 *     it. Polymarket's `/positions` exposes `initialValue` as the
 *     cost-at-entry summed across all opening trades on the position. We
 *     trust their math when it's available.
 *   - FALL_BACK_TO_SIZE_TIMES_AVG — when `initialValue` is missing or
 *     non-positive, derive `size × avgPrice` as the cost proxy. Clamp to
 *     ≥ 0 (the API occasionally returns negative `size` for closed-then-
 *     reopened positions; those are noise for sizing math).
 *   - ZERO_IS_VALID — neither input field present ⇒ return `0`. Caller
 *     handles `Σ ≤ 0` semantics (e.g. planner skips
 *     `target_position_below_threshold`).
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-position-mirror.md (locked design note)
 * @public
 */

/**
 * Polymarket Data-API position shape that carries the fields this helper
 * reads. Wider shapes (the full `PolymarketUserPosition` from the adapter)
 * are structurally compatible — only `initialValue`, `size`, and `avgPrice`
 * are consulted.
 */
export interface PositionCostInput {
  initialValue?: number;
  size?: number;
  avgPrice?: number;
}

/**
 * Coerce a position record to a cost-basis USDC number.
 * @public
 */
export function positionCostUsdc(position: PositionCostInput): number {
  const initial = position.initialValue;
  if (typeof initial === "number" && Number.isFinite(initial) && initial > 0) {
    return initial;
  }
  const size = position.size;
  const avg = position.avgPrice;
  if (
    typeof size === "number" &&
    Number.isFinite(size) &&
    typeof avg === "number" &&
    Number.isFinite(avg)
  ) {
    return Math.max(0, size * avg);
  }
  return 0;
}
