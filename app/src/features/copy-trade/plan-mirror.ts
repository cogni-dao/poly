// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/copy-trade/plan-mirror`
 * Purpose: Pure copy-trade planning function — given a normalized Fill, the target config, and a runtime-state snapshot, return either `place` with a concrete OrderIntent or `skip` with a bounded reason code. Branch selection is target-dominance-driven: target's per-condition cost fractions decide entry/layer/hedge first, then our position state routes within (bug.5048).
 * Scope: Pure function. Does not perform I/O, does not read env, does not import adapters. All runtime state (idempotency set + per-condition target/our position snapshots) is supplied by the caller.
 * Exports: `planMirrorFromFill()` (planner), `analyzeTargetDominance()` (per-condition side-fraction analyzer), `targetVwapForToken()` (per-token VWAP from target_position), `applySizingPolicy()` (sizing helper).
 * Invariants:
 *   - IDEMPOTENT_BY_CLIENT_ID — repeat of the same `(target_id, fill_id)` is silently dropped via `already_placed_ids`. Matches the DB PK on `poly_copy_trade_fills`.
 *   - PLAN_IS_PURE — no side effects; same input → same output.
 *   - CAPS_LIVE_IN_GRANT — daily / hourly USDC caps are enforced downstream by `PolyTraderWalletPort.authorizeIntent` against the tenant's `poly_wallet_grants` row. `planMirrorFromFill` is intentionally unaware of caps so a single cap decision lives in one place (the authorize boundary).
 *   - NO_KILL_SWITCH (bug.0438): there is no per-tenant kill-switch gate. The active-target / active-grant chain in the cross-tenant enumerator is the only gate; an explicit POST of a target IS the user's opt-in.
 *   - TARGET_DOMINANCE_DRIVES_BRANCH (bug.5048): when `config.min_target_side_fraction` is set + target_position is available, `decideMirrorBranch` computes target's dominant side first, then routes by our position state per the spec branch table. Below-threshold (minority) fills always skip as `target_dominant_other_side` — master switch covering entry, layer, AND hedge. When disabled (threshold unset / no target data), legacy our-position routing applies for backward-compat.
 *   - SIZING_PROPORTIONAL_TO_TARGET_SHARE (charter D6): for `target_percentile_scaled`, mirror intent is scaled by target's cost-basis fraction on the fill's token. Minority-side fills sized below market min skip rather than place. Prevents the inverted-weighting failure mode (Sinner/Ruud 2026-05-17, target 99.5/0.5 → mirror 28/72 inverted). Tactical fix; true position-proportional alignment is D2.
 *   - GAP_DRIVES_SIZING (D2 phase 2): for `position_gap`, intent is `(desired_shares − our_shares) × fill.price`, where `desired_shares = target_shares × target_scale`. Each fill is a re-evaluation trigger, not the sizing input. Layer/hedge dispatch short-circuits when this kind is active — gap math produces layering via `desired − ours` directly. `gap ≤ 0` skips `followup_not_needed`; gap below market min skips `below_market_min`. Phase 4's GapExecutor dissolves the remaining fill-driven scaffolding.
 *   - NEVER_PAY_ABOVE_TARGET_VWAP (bug.5048): when `config.vwap_tolerance` is set, `applyVwapGate` skips `vwap_floor_breach` if `fill.price > target_vwap_for_fill_token + tolerance`. Asymmetric upward gate; fails open when target VWAP is unknown.
 *   - HEDGE_PREDICATE_NOOPS_ON_UNKNOWN_OPPOSITE: hedge branch fires only when `state.position.opposite_token_id` is known from prior aggregation. No inference from condition structure alone.
 * Skip-reason precedence (first match wins): already_placed → market_past_end_date → price_outside_clob_bounds → target_dominant_other_side → vwap_floor_breach → sizing-reason skip (below_target_percentile / below_market_min / position_cap_reached / target_position_below_threshold / followup_position_too_small / followup_not_needed) → place.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md, docs/spec/poly-tenant-and-collateral.md, work/items/bug.5048, work/items/task.0318
 * @public
 */

import {
  normalizeLimitPriceToTick,
  type OrderIntent,
} from "@cogni/poly-market-provider";

import type {
  MirrorPlan,
  MirrorReason,
  PlacementPolicy,
  PlanMirrorInput,
  PositionBranch,
  PositionFollowupPolicy,
  PositionGapSizingPolicy,
  SizingPolicy,
  SizingResult,
  TargetConditionPositionView,
} from "./types";

/**
 * Apply a sizing policy to derive the notional USDC to submit for a mirrored
 * fill. Market-floor math stays in share-space, then projects back to USDC
 * only for accounting. Avoids the float round-trip `min × price / price =
 * min − ε` that re-triggered CLOB's sub-min rejection.
 *
 * Invariant SHARE_SPACE_MATH — returned `size_usdc`, when divided by `price`,
 * yields shares ≥ `minShares` (or `minShares === undefined` → share-space
 * guard skipped for backward compat).
 */
export function applySizingPolicy(
  policy: SizingPolicy,
  price: number,
  targetSizeUsdc: number,
  minShares: number | undefined,
  minUsdcNotional: number | undefined,
  cumulativeIntentForToken?: number,
  targetSideFraction?: number
): SizingResult {
  const sized = sizeFromPolicy(
    policy,
    price,
    targetSizeUsdc,
    minShares,
    minUsdcNotional,
    targetSideFraction
  );
  if (!sized.ok) return sized;
  // `position_gap` and `mirror_fill_exact` don't carry
  // `max_usdc_per_condition` — proportional book copy and verbatim mirror are
  // both anti-tracking under a per-trade cap. (`position_gap` runs its own
  // sizer upstream via `applyPositionGapSizing`; `mirror_fill_exact` reaches
  // the switch above with `+Infinity` as the per-trade ceiling. This helper
  // is only reachable for legacy capped policies.)
  if (policy.kind !== "position_gap" && policy.kind !== "mirror_fill_exact") {
    if (
      cumulativeIntentForToken !== undefined &&
      cumulativeIntentForToken + sized.size_usdc > policy.max_usdc_per_condition
    ) {
      return { ok: false, reason: "position_cap_reached" };
    }
  }
  return sized;
}

function sizeFromPolicy(
  policy: SizingPolicy,
  price: number,
  targetSizeUsdc: number,
  minShares: number | undefined,
  minUsdcNotional: number | undefined,
  targetSideFraction: number | undefined
): SizingResult {
  switch (policy.kind) {
    case "min_bet": {
      return applyMarketFloors(
        minUsdcNotional,
        price,
        minShares,
        minUsdcNotional,
        policy.max_usdc_per_condition
      );
    }
    case "target_percentile": {
      if (targetSizeUsdc < policy.statistic.min_target_usdc) {
        return { ok: false, reason: "below_target_percentile" };
      }
      return applyMarketFloors(
        minUsdcNotional,
        price,
        minShares,
        minUsdcNotional,
        policy.max_usdc_per_condition
      );
    }
    case "position_gap": {
      // 2026-05-18 redesign: gap math is the new_entry path for this policy
      // and runs before `sizeFromPolicy` via `applyPositionGapSizing`.
      // Layer/hedge dispatch is short-circuited in `decideMirrorBranch`, so a
      // fill that reaches here under `position_gap` would have to come from a
      // future call site that doesn't route through `decideMirrorBranch`.
      // Defensive fall-through: treat the same as an unsized fill so the
      // planner stays a total function. Phase 4 deletes this branch entirely.
      return { ok: false, reason: "below_market_min" };
    }
    case "mirror_fill_exact": {
      // Verbatim per-fill mirror. `targetSizeUsdc` is `fill.size_usdc` (see
      // `targetSizingUsdcForFill`). Skip — do NOT clamp up — when target's
      // fill is below the effective market floor; clamping up would bet
      // strictly more than target did, silently distorting the ROI-parity
      // measurement this policy exists to capture. Mirrors
      // `applyPositionGapSizing`'s pre-floor check (lines below): the gap IS
      // the target, overpaying defeats the purpose. Pass `+Infinity` as the
      // upper bound so when above-floor, `applyMarketFloors` only enforces
      // the lower clamp (and never amplifies, since `desiredSizeUsdc >=
      // floor` is already true).
      if (minUsdcNotional !== undefined) {
        const effectiveFloorUsdc = Math.max(
          (minShares ?? 0) * price,
          minUsdcNotional
        );
        if (targetSizeUsdc < effectiveFloorUsdc) {
          return { ok: false, reason: "below_market_min" };
        }
      }
      return applyMarketFloors(
        targetSizeUsdc,
        price,
        minShares,
        minUsdcNotional,
        Number.POSITIVE_INFINITY
      );
    }
    case "target_percentile_scaled": {
      if (targetSizeUsdc < policy.statistic.min_target_usdc) {
        return { ok: false, reason: "below_target_percentile" };
      }
      const floor = applyMarketFloors(
        minUsdcNotional,
        price,
        minShares,
        minUsdcNotional,
        policy.max_usdc_per_condition
      );
      if (!floor.ok) return floor;
      const denominator =
        policy.statistic.max_target_usdc - policy.statistic.min_target_usdc;
      const ratio =
        denominator <= 0
          ? 1
          : Math.min(
              1,
              Math.max(
                0,
                (targetSizeUsdc - policy.statistic.min_target_usdc) /
                  denominator
              )
            );
      // SIZING_PROPORTIONAL_TO_TARGET_SHARE (charter D6): scale by target's
      // cost-basis fraction on the fill's token. Skip below `minUsdcNotional`
      // (NOT `floor.size_usdc` — that can equal the per-condition cap in
      // tight-cap markets and false-positive dominant near-1.0 fractions;
      // observed candidate-a 2026-05-17: max=$5 floor=$5 fraction=0.99).
      const sideFraction = targetSideFraction ?? 1;
      const desiredSizeUsdc =
        (floor.size_usdc +
          (policy.max_usdc_per_condition - floor.size_usdc) * ratio) *
        sideFraction;
      if (desiredSizeUsdc < (minUsdcNotional ?? 0)) {
        return { ok: false, reason: "below_market_min" };
      }
      return applyMarketFloors(
        desiredSizeUsdc,
        price,
        minShares,
        minUsdcNotional,
        policy.max_usdc_per_condition
      );
    }
  }
}

/**
 * 2026-05-26 rewrite — range-relative + forward-only baseline (task.5014).
 *
 * **North star.** Anchor desired exposure to where target sits in their
 * ASSUMED per-condition position range (hardcoded ceiling), measured
 * relative to the per-(billing, target, condition) baseline snapshot taken at
 * first post-activation observation. We mirror forward growth only.
 *
 * **Math (per fill):**
 *   delta          = max(0, target_position_usdc_on_condition − baseline)
 *   relative       = min(delta / target_range_max_usdc, 1.0)
 *   desired_usdc   = mirror_max_alloc_per_condition_usdc × relative
 *   desired_shares = desired_usdc / fill.price
 *   gap_shares     = desired_shares − our_shares
 *   gap ≤ 0  → skip followup_not_needed                    (NO SELL)
 *
 * **Forward-only via baseline (FORWARD_ONLY_VIA_BASELINE).** When
 * `state.target_condition_baseline_usdc` is absent, the pipeline just captured
 * the baseline (INSERT ON CONFLICT DO NOTHING into
 * `poly_copy_target_condition_baseline`). The triggering fill itself has
 * `delta = 0` by construction → skip `before_baseline_snapshot`. ~1 missed
 * entry per (target, condition) lifetime; bounded cost, do not "optimize".
 *
 * **Range breach.** When `delta ≥ target_range_max_usdc`, clamp `relative = 1.0`
 * and emit `poly.mirror.range_breach` (operator's signal to raise the ceiling
 * if appropriate).
 *
 * **No per-trade cap.** `position_gap` passes `+Infinity` to
 * `applyMarketFloors` so only the market-floor LOWER bound applies. Wire-level
 * safety lives in `poly_wallet_grants` (`CAPS_LIVE_IN_GRANT`).
 *
 * **Knob ratio invariant (bug.5026).** `mirror_max_alloc_per_condition_usdc`
 * is BOTH the saturation $ value AND the per-condition ceiling — at saturation
 * (`delta ≥ target_range_max_usdc`) `desired_usdc` peaks at exactly
 * `max_alloc_per_condition_usdc`. Setting `max_alloc << range_max` does NOT
 * "track at full scale capped at max_alloc"; it produces a `max_alloc/range_max`-
 * scale mirror whose every fill falls under the CLOB floor. The contract guard
 * `validatePositionGapRangeKnobs` rejects ratios below `MIN_ALLOC_TO_RANGE_RATIO`
 * (`packages/node-contracts/src/poly.copy-trade.targets.v1.contract.ts`) so the
 * misconfig is loud at write-time instead of silent at runtime. For a 1:1
 * proportional mirror, set `max_alloc_per_condition_usdc = target_range_max_usdc`.
 *
 * **Multi-outcome and neg-risk.** No special case. Per-condition-sum scale
 * (in `target_position_usdc_on_condition`) handles binary, true multi-outcome
 * (>2 tokens), and neg-risk parent-event sub-conditions identically — each
 * fill places against the specific token's price and our specific token gap.
 *
 * See docs/research/poly/range-relative-mirror-2026-05-26.md (design),
 *     docs/research/poly/range-relative-parameterization-2026-05-26.md (knob values).
 */
function applyPositionGapSizing(
  policy: PositionGapSizingPolicy,
  fill: PlanMirrorInput["fill"],
  state: PlanMirrorInput["state"],
  minShares: number | undefined,
  minUsdcNotional: number | undefined
): SizingResult {
  const tokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";
  if (tokenId === "") {
    return { ok: false, reason: "below_market_min" };
  }
  // FORWARD_ONLY_VIA_BASELINE — no baseline persisted yet means this is the
  // first post-activation fill on (billing, target, condition). The pipeline
  // is responsible for capturing the baseline via INSERT ON CONFLICT DO
  // NOTHING; this planner returns the bounded skip reason. `delta = 0` by
  // construction on the trigger fill (baseline captures the post-fill state),
  // so even without this guard the math below would yield `desired = 0`.
  // Explicit skip lets the pipeline distinguish "first observation" from
  // "ongoing followup that produced no gap".
  if (state.target_condition_baseline_usdc === undefined) {
    return { ok: false, reason: "before_baseline_snapshot" };
  }
  // Σ ≤ 0 guard — target must have a hydrated per-condition position. Skip
  // rather than treat absence as zero (would emit spurious place attempts on
  // markets we have no target signal for).
  const targetPositionUsdc = state.target_position_usdc_on_condition;
  if (targetPositionUsdc === undefined || targetPositionUsdc <= 0) {
    return { ok: false, reason: "target_position_below_threshold" };
  }
  // RANGE_DRIVES_DESIRED — relative walks 0..1 from baseline to ceiling.
  const delta = Math.max(
    0,
    targetPositionUsdc - state.target_condition_baseline_usdc
  );
  const relative = Math.min(delta / policy.target_range_max_usdc, 1.0);
  const desiredUsdc = policy.mirror_max_alloc_per_condition_usdc * relative;
  if (desiredUsdc <= 0) {
    // delta ≤ 0 → target hasn't grown past baseline (or has reduced). NO SELL.
    return { ok: false, reason: "followup_not_needed" };
  }
  const desiredShares = desiredUsdc / fill.price;
  const ourShares =
    state.position?.our_token_id === tokenId
      ? state.position.our_qty_shares
      : 0;
  const gapShares = desiredShares - ourShares;
  if (gapShares <= 0) {
    return { ok: false, reason: "followup_not_needed" };
  }
  const gapUsdc = gapShares * fill.price;
  // When the gap itself is below the effective market floor, skip rather
  // than round up. `applyMarketFloors` clamps up by design (so legacy
  // "place at market min" policies always land a placeable order), but for
  // position_gap the gap IS the target — overpaying to clear the floor
  // would re-introduce the inverted-weighting failure mode this policy
  // exists to prevent. Mirror `applyMarketFloors`'s floor calc here:
  // `floorUsdc = max(minShares × price, minUsdcNotional)`. Low-tick markets
  // (e.g. minShares=5, price=0.85 → $4.25) have floors well above
  // minUsdcNotional alone.
  if (minUsdcNotional !== undefined) {
    const effectiveFloorUsdc = Math.max(
      (minShares ?? 0) * fill.price,
      minUsdcNotional
    );
    if (gapUsdc < effectiveFloorUsdc) {
      return { ok: false, reason: "below_market_min" };
    }
  }
  // **NO per-trade ceiling under `position_gap`** — per-fill clamps would
  // throttle proportional tracking. The grant chain (`poly_wallet_grants`,
  // `CAPS_LIVE_IN_GRANT`) is the only cross-fill safety stop. Pass `+Infinity`
  // so `applyMarketFloors` only enforces the lower bound (market floor).
  return applyMarketFloors(
    gapUsdc,
    fill.price,
    minShares,
    minUsdcNotional,
    Number.POSITIVE_INFINITY
  );
}

function applyMarketFloors(
  desiredSizeUsdc: number | undefined,
  price: number,
  minShares: number | undefined,
  minUsdcNotional: number | undefined,
  maxUsdcPerCondition: number
): SizingResult {
  // Fail closed when market constraints are unknown — without minUsdcNotional
  // we have no defensible "min" to bet.
  if (desiredSizeUsdc === undefined || minUsdcNotional === undefined) {
    return { ok: false, reason: "below_market_min" };
  }
  const sharesForUsdcFloor = minUsdcNotional / price;
  const floorShares = Math.max(minShares ?? 0, sharesForUsdcFloor);
  const rawFloorUsdc = floorShares * price;
  // The share×price round-trip (e.g. `1/0.09 * 0.09 = 0.9999…`) can leave
  // floorShares×price a hair below minUsdcNotional. Clamp up so the adapter's
  // own USDC-floor re-check doesn't bounce. bug.0342.
  const floorUsdc =
    rawFloorUsdc < minUsdcNotional ? minUsdcNotional : rawFloorUsdc;
  const size_usdc = Math.min(
    Math.max(desiredSizeUsdc, floorUsdc),
    maxUsdcPerCondition
  );
  if (size_usdc < floorUsdc) {
    return { ok: false, reason: "below_market_min" };
  }
  return { ok: true, size_usdc };
}

/**
 * Translate an observed target fill into a concrete mirror plan.
 *
 * Order of checks (short-circuits on the first skip reason):
 *   1. already placed (PK+cid)        → skip/already_placed
 *   2. market past Gamma `end_date`   → skip/market_past_end_date  (bug.5043)
 *   3. price outside CLOB tick grid   → skip/price_outside_clob_bounds
 *   4. `decideMirrorBranch`           → skip/target_dominant_other_side (bug.5048)
 *                                       OR place-branch selection (new_entry / layer / hedge)
 *                                       with pre-computed `SizingResult`
 *   5. VWAP gate                      → skip/vwap_floor_breach (bug.5048)
 *   6. sizing.ok check                → skip/below_target_percentile | below_market_min |
 *                                       position_cap_reached | target_position_below_threshold |
 *                                       followup_position_too_small | followup_not_needed
 *   7. mode === 'paper'               → place (paper adapter)
 *   8. otherwise                      → place (live), reason ∈ {ok, layer_scale_in, hedge_followup}
 *
 * Branch selection is target-dominance-driven (TARGET_DOMINANCE_DRIVES_BRANCH):
 * `state.target_position.tokens[].cost_usdc` gives per-side fractions; the
 * incoming fill's token is classified minority/dominant against
 * `config.min_target_side_fraction`. Minority fills always skip (master
 * switch). See spec branch table in `poly-copy-trade-execution.md`.
 *
 * Daily / hourly caps are NOT checked here — those live on the tenant's
 * `poly_wallet_grants` row and are enforced by `authorizeIntent` at the
 * executor boundary (CAPS_LIVE_IN_GRANT invariant).
 */
export function planMirrorFromFill(input: PlanMirrorInput): MirrorPlan {
  const {
    fill,
    config,
    state,
    client_order_id,
    min_shares,
    min_usdc_notional,
    tick_size,
    now_ms,
  } = input;

  // Idempotency gate. Two checks, both correct:
  //   1. COID membership — fast-path for fresh in-tick placements (the COID
  //      we just computed already lives in the ledger).
  //   2. fill_id membership — durable backstop. Catches pre-cutover rows
  //      whose stored COID was computed with the legacy 2-arg
  //      `clientOrderIdFor(target_id, fill_id)` and therefore won't match
  //      the new 3-arg form for the same (target, fill). Without this, a
  //      cursor regression that re-feeds an old fill would skip the COID
  //      check and try to re-place — duplicate live order on PROD if the
  //      market is still active. See the multi-tenant fills PK migration.
  if (
    state.already_placed_ids.includes(client_order_id) ||
    state.placed_fill_ids.includes(fill.fill_id)
  ) {
    return {
      kind: "skip",
      reason: "already_placed",
      position_branch: "new_entry",
    };
  }

  if (now_ms !== undefined && isFillPastMarketEndDate(fill, now_ms)) {
    return {
      kind: "skip",
      reason: "market_past_end_date",
      position_branch: "new_entry",
    };
  }

  const normalizedPrice = tick_size
    ? normalizeLimitPriceToTick(fill.price, tick_size)
    : ({ ok: true, price: fill.price } as const);
  if (!normalizedPrice.ok) {
    return {
      kind: "skip",
      reason: "price_outside_clob_bounds",
      position_branch: "new_entry",
    };
  }

  const planningInput =
    normalizedPrice.price === fill.price
      ? input
      : ({
          ...input,
          fill: { ...fill, price: normalizedPrice.price },
        } as const);

  const decision = decideMirrorBranch(
    planningInput,
    min_shares,
    min_usdc_notional
  );

  if (decision.kind === "skip") {
    return {
      kind: "skip",
      reason: decision.reason,
      position_branch: decision.position_branch,
    };
  }

  // VWAP gate (bug.5048) — applied AFTER branch selection, BEFORE sizing
  // finalization. Fires on every place-bound branch. Fails open when target
  // VWAP for the fill's token is unknown.
  const vwapSkip = applyVwapGate(planningInput);
  if (vwapSkip !== undefined) {
    return {
      kind: "skip",
      reason: vwapSkip,
      position_branch: decision.position_branch,
    };
  }

  if (!decision.sizing.ok) {
    return {
      kind: "skip",
      reason: decision.sizing.reason,
      position_branch: decision.position_branch,
    };
  }

  const intent = buildIntent(
    fill,
    decision.sizing.size_usdc,
    client_order_id,
    config.placement,
    decision.position_branch,
    normalizedPrice.price
  );

  return {
    kind: "place",
    reason: decision.reason,
    position_branch: decision.position_branch,
    intent,
    wrong_side_holding_detected: decision.wrong_side_holding_detected,
  };
}

/**
 * bug.5048 — analyze target's per-condition cost distribution and report
 * whether the incoming fill is on target's minority side. Gate disabled when
 * `threshold` is undefined or target_position is unavailable (fail-open per
 * TARGET_DOMINANCE_FAIL_OPEN_ON_MISSING_DATA).
 */
interface TargetDominanceSignal {
  /** True when threshold + target data are both available and total cost > 0. */
  dominance_known: boolean;
  /** True when gate fired: fill is on target's minority side (fraction < threshold). */
  fill_is_minority: boolean;
  /** Token id with highest cost when dominance_known; else undefined. */
  dominant_token_id: string | undefined;
  /**
   * Fraction of target's total cost on the fill's token. Computed whenever
   * target_position data is available — independent of `threshold`, so D6
   * sizing can scale by it even when the dominance gate is disabled. `null`
   * only when target data is missing or total cost is zero.
   */
  fill_token_fraction: number | null;
}

export function analyzeTargetDominance(
  targetPosition: TargetConditionPositionView | undefined,
  threshold: number | undefined,
  fillTokenId: string
): TargetDominanceSignal {
  const disabled: TargetDominanceSignal = {
    dominance_known: false,
    fill_is_minority: false,
    dominant_token_id: undefined,
    fill_token_fraction: null,
  };
  if (
    !targetPosition ||
    targetPosition.tokens.length === 0 ||
    fillTokenId === ""
  ) {
    return disabled;
  }
  let total = 0;
  let fillCost = 0;
  let dominantTokenId: string | undefined;
  let dominantCost = -1;
  for (const t of targetPosition.tokens) {
    total += t.cost_usdc;
    if (t.token_id === fillTokenId) fillCost += t.cost_usdc;
    if (t.cost_usdc > dominantCost) {
      dominantCost = t.cost_usdc;
      dominantTokenId = t.token_id;
    }
  }
  if (total <= 0) return disabled;
  const fraction = fillCost / total;
  const gateActive = threshold !== undefined && threshold > 0;
  return {
    dominance_known: gateActive,
    fill_is_minority: gateActive && fraction < threshold,
    dominant_token_id: gateActive ? dominantTokenId : undefined,
    fill_token_fraction: fraction,
  };
}

/**
 * bug.5048 — target's VWAP on a specific token, derived from
 * `cost_usdc / size_shares`. Returns undefined when shares are zero or token
 * is absent (fail-open semantics).
 */
export function targetVwapForToken(
  targetPosition: TargetConditionPositionView | undefined,
  tokenId: string
): number | undefined {
  if (!targetPosition || tokenId === "") return undefined;
  let cost = 0;
  let shares = 0;
  for (const t of targetPosition.tokens) {
    if (t.token_id === tokenId) {
      cost += t.cost_usdc;
      shares += t.size_shares;
    }
  }
  if (shares <= 0) return undefined;
  return cost / shares;
}

/**
 * bug.5048 — refuse to place above target's average entry on the fill's
 * token. Tolerance is asymmetric (upward only); we are happy to enter below
 * target VWAP. Fail-open when target VWAP is unknown.
 */
function applyVwapGate(
  input: PlanMirrorInput
): "vwap_floor_breach" | undefined {
  const tolerance = input.config.vwap_tolerance;
  if (tolerance === undefined) return undefined;
  const tokenId =
    typeof input.fill.attributes?.asset === "string"
      ? input.fill.attributes.asset
      : "";
  if (tokenId === "") return undefined;
  const vwap = targetVwapForToken(input.state.target_position, tokenId);
  if (vwap === undefined) return undefined;
  if (input.fill.price > vwap + tolerance) return "vwap_floor_breach";
  return undefined;
}

/**
 * bug.5048 — single entry-point branch decision. Replaces the legacy
 * `applyPositionFollowupPolicy` which selected branches off OUR position
 * first. Now: target's dominant side drives the routing, our position is
 * downstream.
 *
 * Modes:
 *   1. Dominance routing (when `config.min_target_side_fraction` is set AND
 *      target_position is available with non-zero total cost). Implements the
 *      bug.5048 branch table.
 *   2. Legacy our-position routing (fallback). Preserves existing tests that
 *      did not configure the dominance gate. fill on `our_token_id` → layer;
 *      fill on `opposite_token_id` → hedge; else → new_entry.
 *
 * Invariants: TARGET_DOMINANCE_DRIVES_BRANCH (when enabled),
 * OPTION_C_TOLERATES_MULTI_TARGET, MIRROR_REASON_BOUNDED, PLANNER_IS_PURE.
 */
type BranchDecision =
  | {
      kind: "skip";
      reason: Exclude<MirrorReason, "ok" | "sell_closed_position">;
      position_branch: PositionBranch;
    }
  | {
      kind: "place";
      reason: "ok" | "layer_scale_in" | "hedge_followup";
      position_branch: PositionBranch;
      sizing: SizingResult;
      wrong_side_holding_detected: boolean;
    };

function decideMirrorBranch(
  input: PlanMirrorInput,
  minShares: number | undefined,
  minUsdcNotional: number | undefined
): BranchDecision {
  const { fill, config, state } = input;
  const fillTokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";

  const dominance = analyzeTargetDominance(
    state.target_position,
    config.min_target_side_fraction,
    fillTokenId
  );

  // Gate: minority-side fills are below the configured conviction
  // threshold for this condition; we never mirror them, regardless of our
  // position state. Master switch — entries, layer scale-in, AND hedges on
  // a below-threshold token all skip. Hedge mirroring only fires when the
  // opposite-side fill itself sits above `min_target_side_fraction` (e.g.
  // a 70/30 target — the 30% side passes the gate and routes to hedge if
  // we hold the 70% primary).
  if (dominance.fill_is_minority) {
    return {
      kind: "skip",
      reason: "target_dominant_other_side",
      position_branch: "new_entry",
    };
  }

  const position = state.position;
  const ourTokenId = position?.our_token_id;
  const oppositeTokenId = position?.opposite_token_id;
  const followup = config.position_followup;

  let isLayer = false;
  let isHedge = false;
  let wrong_side_holding_detected = false;

  if (dominance.dominance_known && dominance.dominant_token_id !== undefined) {
    // Dominance-driven routing (bug.5048).
    const fillIsOnDominant = fillTokenId === dominance.dominant_token_id;
    if (fillIsOnDominant) {
      if (ourTokenId === dominance.dominant_token_id) {
        isLayer = true;
      } else if (
        ourTokenId !== undefined &&
        ourTokenId !== dominance.dominant_token_id
      ) {
        // OPTION_C_TOLERATES_MULTI_TARGET — wallet holds a non-dominant side
        // from cross-target activity. Ignore the wrong-side leg for routing;
        // open the dominant-side parallel leg. Pipeline emits a counter +
        // WARN log when this flag fires.
        wrong_side_holding_detected = true;
      }
    } else {
      // Fill not on dominant; not minority either (gate filtered above).
      // Happens in multi-outcome (e.g. 50/30/20 fill on 30% token with
      // threshold 0.20) or binary 50/50. Route by our-position match.
      isLayer = ourTokenId !== undefined && fillTokenId === ourTokenId;
      isHedge =
        oppositeTokenId !== undefined && fillTokenId === oppositeTokenId;
    }
  } else {
    // Legacy our-position routing (threshold unset or no target data).
    isLayer = ourTokenId !== undefined && fillTokenId === ourTokenId;
    isHedge = oppositeTokenId !== undefined && fillTokenId === oppositeTokenId;
  }

  // Layer/Hedge branches require position_followup AND BUY-side. Without
  // either, fall through to new_entry — matches legacy fall-through.
  //
  // GAP_DRIVES_SIZING (D2 phase 2): when the policy is `position_gap`, the
  // gap math computes layering naturally via `desired − ours`, so we
  // short-circuit the fill-driven layer/hedge dispatch and always route
  // through new_entry. Phase 4 (`GapExecutor`) dissolves layer/hedge
  // entirely.
  //
  // MIRROR_FILL_EXACT_IS_VERBATIM: `mirror_fill_exact` mirrors each fill 1-1
  // by construction — every fill is its own `new_entry`-shaped order at the
  // fill's price/size. Layer/hedge follow-up sizing would inject conviction
  // gates this policy explicitly rejects.
  const skipFollowupDispatch =
    config.sizing.kind === "position_gap" ||
    config.sizing.kind === "mirror_fill_exact";
  if (
    isLayer &&
    !skipFollowupDispatch &&
    followup?.enabled &&
    fill.side === "BUY" &&
    position !== undefined
  ) {
    return {
      kind: "place",
      reason: "layer_scale_in",
      position_branch: "layer",
      sizing: sizeLayerDominant(input, followup, minShares, minUsdcNotional),
      wrong_side_holding_detected,
    };
  }
  if (
    isHedge &&
    !skipFollowupDispatch &&
    followup?.enabled &&
    fill.side === "BUY" &&
    position?.our_token_id !== undefined
  ) {
    return {
      kind: "place",
      reason: "hedge_followup",
      position_branch: "hedge",
      sizing: sizeHedge(input, followup, minShares, minUsdcNotional),
      wrong_side_holding_detected,
    };
  }

  // New entry path. `position_gap` runs its own sizer because the math reads
  // `state.target_position` / `state.position` directly rather than the
  // per-fill notional that drives the other policies.
  return {
    kind: "place",
    reason: "ok",
    position_branch: "new_entry",
    sizing:
      config.sizing.kind === "position_gap"
        ? applyPositionGapSizing(
            config.sizing,
            fill,
            state,
            minShares,
            minUsdcNotional
          )
        : applySizingPolicy(
            config.sizing,
            fill.price,
            targetSizingUsdcForFill(fill, state, config.sizing),
            minShares,
            minUsdcNotional,
            state.cumulative_intent_usdc_for_token,
            dominance.fill_token_fraction ?? undefined
          ),
    wrong_side_holding_detected,
  };
}

/**
 * Layer-branch sizing — verbatim extraction of the layer body from the legacy
 * `applyPositionFollowupPolicy`. Preserves the inherited gates:
 * `min_mirror_position_usdc` + `market_floor_multiple` (via
 * `effectiveMinPositionUsdc`), `max_layer_fraction_of_position`, and the
 * `targetFollowupThreshold` check on the fill's token.
 */
function sizeLayerDominant(
  input: PlanMirrorInput,
  followup: PositionFollowupPolicy,
  minShares: number | undefined,
  minUsdcNotional: number | undefined
): SizingResult {
  const { fill, state, config } = input;
  const position = state.position;
  if (!position) {
    return { ok: false, reason: "followup_position_too_small" };
  }
  const mirrorExposureUsdc = mirrorExposureUsdcForBranch(
    position.our_qty_shares,
    position.our_vwap_usdc,
    fill.price
  );
  const minPositionUsdc = effectiveMinPositionUsdc(followup, minUsdcNotional);
  if (mirrorExposureUsdc < minPositionUsdc) {
    return { ok: false, reason: "followup_position_too_small" };
  }
  const tokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";
  const targetThreshold = targetFollowupThreshold(config.sizing);
  const targetBranchCost = targetTokenCostUsdc(state.target_position, tokenId);
  if (targetBranchCost < targetThreshold) {
    return { ok: false, reason: "target_position_below_threshold" };
  }
  return applyFollowupSizing({
    policy: config.sizing,
    price: fill.price,
    desiredSizeUsdc: minUsdcNotional,
    maxFollowupUsdc:
      mirrorExposureUsdc * followup.max_layer_fraction_of_position,
    minShares,
    minUsdcNotional,
    cumulativeIntentForToken: state.cumulative_intent_usdc_for_token,
  });
}

/**
 * Hedge-branch sizing — verbatim extraction of the hedge body from the legacy
 * `applyPositionFollowupPolicy`. Preserves the inherited gates: shared
 * `min_mirror_position_usdc` + market-floor floor, `targetFollowupThreshold`,
 * `min_target_hedge_usdc`, `min_target_hedge_ratio`, desired-delta positivity,
 * and `max_hedge_fraction_of_position`.
 */
function sizeHedge(
  input: PlanMirrorInput,
  followup: PositionFollowupPolicy,
  minShares: number | undefined,
  minUsdcNotional: number | undefined
): SizingResult {
  const { fill, state, config } = input;
  const position = state.position;
  if (!position?.our_token_id) {
    return { ok: false, reason: "followup_position_too_small" };
  }
  const mirrorExposureUsdc = mirrorExposureUsdcForBranch(
    position.our_qty_shares,
    position.our_vwap_usdc,
    fill.price
  );
  const minPositionUsdc = effectiveMinPositionUsdc(followup, minUsdcNotional);
  if (mirrorExposureUsdc < minPositionUsdc) {
    return { ok: false, reason: "followup_position_too_small" };
  }
  const tokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";
  const targetThreshold = targetFollowupThreshold(config.sizing);
  const targetHedgeCost = targetTokenCostUsdc(state.target_position, tokenId);
  if (targetHedgeCost < targetThreshold) {
    return { ok: false, reason: "target_position_below_threshold" };
  }
  if (targetHedgeCost < followup.min_target_hedge_usdc) {
    return { ok: false, reason: "target_position_below_threshold" };
  }
  const targetPrimaryCost = targetTokenCostUsdc(
    state.target_position,
    position.our_token_id
  );
  const targetHedgeRatio =
    targetPrimaryCost > 0 ? targetHedgeCost / targetPrimaryCost : 0;
  if (targetHedgeRatio < followup.min_target_hedge_ratio) {
    return { ok: false, reason: "target_position_below_threshold" };
  }
  const existingHedgeUsdc = position.opposite_qty_shares * fill.price;
  const desiredHedgeUsdc = mirrorExposureUsdc * targetHedgeRatio;
  const desiredDeltaUsdc = desiredHedgeUsdc - existingHedgeUsdc;
  if (desiredDeltaUsdc <= 0) {
    return { ok: false, reason: "followup_not_needed" };
  }
  return applyFollowupSizing({
    policy: config.sizing,
    price: fill.price,
    desiredSizeUsdc: desiredDeltaUsdc,
    maxFollowupUsdc:
      mirrorExposureUsdc * followup.max_hedge_fraction_of_position,
    minShares,
    minUsdcNotional,
    cumulativeIntentForToken: state.cumulative_intent_usdc_for_token,
  });
}

function targetSizingUsdcForFill(
  fill: PlanMirrorInput["fill"],
  state: PlanMirrorInput["state"],
  policy: SizingPolicy
): number {
  // `min_bet` reads the fill notional but its sizer ignores it (returns
  // market floor). `mirror_fill_exact` reads it AND its sizer outputs it
  // verbatim — that's the whole policy.
  if (policy.kind === "min_bet" || policy.kind === "mirror_fill_exact") {
    return fill.size_usdc;
  }
  const tokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";
  // `position_gap` defers to its own sizer and shouldn't reach this helper
  // for branch routing; returning the target's per-token cost keeps any
  // future caller's follow-up gates well-defined.
  return targetTokenCostUsdc(state.target_position, tokenId);
}

function mirrorExposureUsdcForBranch(
  shares: number,
  vwap: number | undefined,
  fillPrice: number
): number {
  return shares * (vwap ?? fillPrice);
}

function effectiveMinPositionUsdc(
  policy: PositionFollowupPolicy,
  minUsdcNotional: number | undefined
): number {
  const marketFloorMin =
    minUsdcNotional === undefined
      ? 0
      : minUsdcNotional * policy.market_floor_multiple;
  return Math.max(policy.min_mirror_position_usdc, marketFloorMin);
}

function targetFollowupThreshold(policy: SizingPolicy): number {
  switch (policy.kind) {
    case "target_percentile":
    case "target_percentile_scaled":
      return policy.statistic.min_target_usdc;
    case "min_bet":
    case "position_gap":
    case "mirror_fill_exact":
      return 0;
  }
}

/**
 * Gamma's market `endDate` (carried verbatim on `fill.attributes.end_date` per
 * the Data-API + chain-source normalizers) is the scheduled close time of the
 * market. Mirroring a BUY past that point spends real USDC on a near-dead
 * market. Defensive: an absent or unparseable `end_date` short-circuits to
 * `false` so we never drop a fill due to a missing field.
 *
 * Boundary semantics (bug.5007). Gamma returns `endDate` as a **date-only**
 * `"YYYY-MM-DD"` string for the vast majority of markets. `Date.parse` resolves
 * that to **00:00:00Z at the START** of the day — but Polymarket's markets
 * remain tradable well into the day printed in `endDate`. Verified live
 * 2026-05-17T07:20Z against `gamma-api.polymarket.com`: e.g. `lal-sev-rea`
 * (LaLiga, `endDate=2026-05-17`, `gameStartTime=2026-05-17T17:00Z` ~9.5h in
 * the future) reports `acceptingOrders=true`, `volume=$131,595` — fully alive
 * 7h past the literal `Date.parse("2026-05-17")` boundary. The original
 * commit's "midnight-UTC close" assumption (bug.5043) was incorrect: an
 * `endDate` of `"YYYY-MM-DD"` should be treated as end-of-day, not start.
 *
 * Fix: for date-only inputs, shift the comparison to `endMs + 24h` so the
 * gate only fires after the day printed in `endDate` has fully elapsed in
 * UTC. Full ISO-8601 timestamps (rare; some markets do carry these) compare
 * verbatim — the existing tests asserting `>=` at the exact ISO boundary
 * still hold for that path.
 *
 * Caveat (unchanged from bug.5045): catches the case where the chain settles
 * AFTER scheduled close, not the inverse. Markets that resolve early (sports
 * markets settle when the game ends) are still NOT caught here — those need
 * a `poly_market_outcomes.resolved_at` join at snapshot time.
 */
function isFillPastMarketEndDate(
  fill: PlanMirrorInput["fill"],
  nowMs: number
): boolean {
  const raw = fill.attributes?.end_date;
  if (typeof raw !== "string" || raw.length === 0) return false;
  const endMs = Date.parse(raw);
  if (!Number.isFinite(endMs)) return false;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const effectiveEndMs = isDateOnly ? endMs + 24 * 60 * 60 * 1000 : endMs;
  return nowMs >= effectiveEndMs;
}

function targetTokenCostUsdc(
  targetPosition: TargetConditionPositionView | undefined,
  tokenId: string | undefined
): number {
  if (!targetPosition || !tokenId) return 0;
  return targetPosition.tokens
    .filter((token) => token.token_id === tokenId)
    .reduce((sum, token) => sum + token.cost_usdc, 0);
}

function applyFollowupSizing(params: {
  policy: SizingPolicy;
  price: number;
  desiredSizeUsdc: number | undefined;
  maxFollowupUsdc: number;
  minShares: number | undefined;
  minUsdcNotional: number | undefined;
  cumulativeIntentForToken: number | undefined;
}): SizingResult {
  // Layer/hedge follow-up is short-circuited under `position_gap` (gap math
  // produces layering via desired − ours) and `mirror_fill_exact` (verbatim
  // per-fill). This helper should never see either; narrow defensively +
  // fail-closed if a future refactor breaks that invariant.
  if (
    params.policy.kind === "position_gap" ||
    params.policy.kind === "mirror_fill_exact"
  ) {
    return { ok: false, reason: "followup_not_needed" };
  }
  const maxUsdc = Math.min(
    params.policy.max_usdc_per_condition,
    params.maxFollowupUsdc
  );
  const sized = applyMarketFloors(
    params.desiredSizeUsdc,
    params.price,
    params.minShares,
    params.minUsdcNotional,
    maxUsdc
  );
  if (!sized.ok) return sized;
  if (
    params.cumulativeIntentForToken !== undefined &&
    params.cumulativeIntentForToken + sized.size_usdc >
      params.policy.max_usdc_per_condition
  ) {
    return { ok: false, reason: "position_cap_reached" };
  }
  return sized;
}

/**
 * Build a canonical `OrderIntent` from the fill + target config.
 * Mirror size is the selected sizing-policy output, never an adapter concern.
 * The planner is mode-agnostic — execution mode is stamped by the ledger from
 * `PAPER_ENFORCE_MODE` env (MODE_STAMPED_AT_LEDGER_FROM_ENV in
 * order-ledger.ts). Pair with `PAPER_DISPATCH_IS_ENV_ONLY` in
 * poly-trade-executor.ts.
 */
function buildIntent(
  fill: PlanMirrorInput["fill"],
  size_usdc: number,
  client_order_id: `0x${string}`,
  policy: PlacementPolicy,
  position_branch: PositionBranch,
  limit_price: number
): OrderIntent {
  const placement: "limit" | "market_fok" =
    policy.kind === "mirror_limit" ? "limit" : "market_fok";
  const tokenId =
    typeof fill.attributes?.asset === "string" ? fill.attributes.asset : "";

  return {
    provider: "polymarket",
    market_id: fill.market_id,
    outcome: fill.outcome,
    side: fill.side,
    size_usdc,
    limit_price,
    client_order_id,
    attributes: {
      token_id: tokenId,
      condition_id:
        typeof fill.attributes?.condition_id === "string"
          ? fill.attributes.condition_id
          : undefined,
      source_fill_id: fill.fill_id,
      target_wallet: fill.target_wallet,
      placement,
      position_branch,
      title:
        typeof fill.attributes?.title === "string"
          ? fill.attributes.title
          : undefined,
      slug:
        typeof fill.attributes?.slug === "string"
          ? fill.attributes.slug
          : undefined,
      event_slug:
        typeof fill.attributes?.event_slug === "string"
          ? fill.attributes.event_slug
          : undefined,
      event_title:
        typeof fill.attributes?.event_title === "string"
          ? fill.attributes.event_title
          : undefined,
      end_date:
        typeof fill.attributes?.end_date === "string"
          ? fill.attributes.end_date
          : undefined,
      game_start_time:
        typeof fill.attributes?.game_start_time === "string"
          ? fill.attributes.game_start_time
          : undefined,
      transaction_hash:
        typeof fill.attributes?.transaction_hash === "string"
          ? fill.attributes.transaction_hash
          : undefined,
    },
  };
}
