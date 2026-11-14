// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/server/market-return-math`
 * Purpose: Pure formulas for the dashboard Markets aggregation table —
 *   per-position cost-basis-deployed return, target-blend, and the
 *   rate-gap / size-scaled-gap pair that drives the "alpha leak" sort.
 *   No DB, no env, no logging — every input is provided by the caller
 *   so this module can be unit-tested directly against the worked
 *   examples in poly-markets-aggregation-redesign §3.3.
 * Scope: Pure functions. Imported by `market-exposure-service.ts`.
 * Invariants:
 *   - MODIFIED_DIETZ_V_BEGIN_ZERO: positionReturnPct treats every BUY as
 *     committed capital and every SELL as cash credited back, with the
 *     starting position implicitly zero (we never carry a position into
 *     a copy-trade condition).
 *   - NULL_WHEN_UNDEFINED: divide-by-zero on `totalBuyNotional` returns
 *     `null`, never `Infinity` / `NaN`. UI must render `—`.
 *   - SIGN_CONVENTION_TARGET_MINUS_US: `rateGapPct` is
 *     `targetReturnPct − ourReturnPct`. Positive = target ahead = leak.
 *   - SIZE_SCALED_ON_OUR_BOOK: `sizeScaledGapUsdc` is denominated in OUR
 *     buy notional, not target's. Stays bounded to our portfolio scale.
 *   - OUTCOME_AUTHORITATIVE_REMAINING_VALUE: when `marketOutcome` is
 *     `winner` or `loser`, `computeRealizedPnl` derives the remaining-
 *     shares value from outcome (`netShares × $1` for winners, `0` for
 *     losers) and ignores `currentMarkValue`. This sidesteps Polymarket's
 *     stale-echo race — Data API rows continue to mid-price after CTF
 *     burn — and yields the deterministic payout that recovers a
 *     redeemed winner's P/L. `currentMarkValue` is only consulted for
 *     unresolved markets (`outcome` null or `"unknown"`).
 * Side-effects: none
 * @internal
 */

export type PositionReturnInput = {
  /** Σ size_usdc over fills WHERE side='BUY'. */
  totalBuyNotional: number;
  /** Σ size_usdc over fills WHERE side='SELL'. */
  realizedCash: number;
  /** Σ over open legs of (shares × current_price). MTM, only used when
   *  no `redemptionProceeds` is supplied (= unresolved market). */
  currentMarkValue: number;
  /**
   * Redemption value of any winning shares still attributable to the
   * wallet (`max(0, netShares) × $1` when the market resolved YES on this
   * token; `0` for losers). Callers compute this via `computeRealizedPnl`
   * and pass it in. When provided, it REPLACES `currentMarkValue` in the
   * return-numerator — the outcome is authoritative, the mark is noisy
   * post-resolution.
   */
  redemptionProceeds?: number;
};

export type MarketOutcome = "winner" | "loser" | "unknown" | null;

export type RealizedPnlInput = {
  totalBuyNotional: number;
  realizedCash: number;
  currentMarkValue: number;
  /** Σ BUY shares − Σ SELL shares from poly_trader_fills. */
  netShares: number;
  marketOutcome: MarketOutcome;
};

export type RealizedPnl = {
  pnlUsd: number;
  pnlPct: number | null;
  redemptionProceeds: number;
};

export type EdgeGapInput = {
  ourReturnPct: number | null;
  targetReturnPct: number | null;
  ourTotalBuyNotional: number;
};

export type EdgeGap = {
  rateGapPct: number | null;
  sizeScaledGapUsdc: number | null;
};

export type TargetBlendEntry = {
  totalBuyNotional: number;
  returnPct: number | null;
};

const PCT_DECIMALS = 4;
const USD_DECIMALS = 2;

/**
 * Cost-basis-deployed return for one (wallet, condition).
 * `null` when totalBuyNotional <= 0.
 */
export function positionReturnPct(input: PositionReturnInput): number | null {
  const { totalBuyNotional, realizedCash, currentMarkValue } = input;
  if (!Number.isFinite(totalBuyNotional) || totalBuyNotional <= 0) return null;
  if (!Number.isFinite(realizedCash) || !Number.isFinite(currentMarkValue)) {
    return null;
  }
  // Outcome-authoritative remaining-value: redemption (when supplied AND
  // actually nonzero) replaces the noisy current mark for resolved markets.
  // For open positions and losers the aggregate `redemptionProceeds` is 0
  // — fall back to `currentMarkValue` so we don't compute a fake -100%
  // return. (bug.5057: prior `0 !== undefined` conditional matched on the
  // open-position case where every leg has redemptionProceedsUsdc=0,
  // making both our and target returnPct = -totalBuy/totalBuy = -100% and
  // collapsing every dashboard Δ to 0.0%.)
  const remainingValue =
    input.redemptionProceeds !== undefined &&
    Number.isFinite(input.redemptionProceeds) &&
    input.redemptionProceeds > 0
      ? input.redemptionProceeds
      : currentMarkValue;
  const totalPnl = realizedCash + remainingValue - totalBuyNotional;
  return roundPct(totalPnl / totalBuyNotional);
}

/**
 * Pair of metrics for the Markets table sort + display.
 * `null` propagates: if either return is null we cannot compute the gap.
 */
export function edgeGap(input: EdgeGapInput): EdgeGap {
  const { ourReturnPct, targetReturnPct, ourTotalBuyNotional } = input;
  if (ourReturnPct === null || targetReturnPct === null) {
    return { rateGapPct: null, sizeScaledGapUsdc: null };
  }
  if (!Number.isFinite(ourTotalBuyNotional) || ourTotalBuyNotional <= 0) {
    // Rate gap is still defined; dollar scaling is not.
    return {
      rateGapPct: roundPct(targetReturnPct - ourReturnPct),
      sizeScaledGapUsdc: null,
    };
  }
  const rate = targetReturnPct - ourReturnPct;
  return {
    rateGapPct: roundPct(rate),
    sizeScaledGapUsdc: roundUsd(rate * ourTotalBuyNotional),
  };
}

/**
 * Cost-basis-weighted blend across N active copy-targets on one
 * condition. Weights are each target's `totalBuyNotional`. Targets
 * with `null` returnPct (zero-buy-notional rows) are excluded from
 * both numerator and denominator. Returns `null` if no target has
 * positive buy notional with a defined return.
 */
export function blendTargetReturns(
  entries: readonly TargetBlendEntry[]
): number | null {
  let weightedSum = 0;
  let weightSum = 0;
  for (const e of entries) {
    if (e.returnPct === null) continue;
    if (!Number.isFinite(e.totalBuyNotional) || e.totalBuyNotional <= 0) {
      continue;
    }
    weightedSum += e.totalBuyNotional * e.returnPct;
    weightSum += e.totalBuyNotional;
  }
  if (weightSum <= 0) return null;
  return roundPct(weightedSum / weightSum);
}

/**
 * Realized P/L for one (wallet, condition, token) leg in USD.
 *
 * For resolved markets the outcome — not the current mark — dictates the
 * remaining-shares value:
 *
 *   - `winner`: pnlUsd = realizedCash + (max(0, netShares) × $1) − totalBuyNotional
 *   - `loser`:  pnlUsd = realizedCash − totalBuyNotional
 *   - `unknown` / null: pnlUsd = realizedCash + currentMarkValue − totalBuyNotional  (MTM)
 *
 * Using the deterministic outcome instead of `currentMarkValue` for
 * resolved markets sidesteps two real-world races: (a) Polymarket
 * continues to echo a row with stale `current_value_usdc` for several
 * minutes after CTF burn, which would otherwise leak the payout into
 * "still on chain" and zero out the redemption credit; (b) winners that
 * mark at ~$0.95 mid-resolution would under-count their realized payout.
 *
 * `pnlPct` is `pnlUsd / totalBuyNotional`, `null` when no capital was
 * deployed. Renders as `—` upstream.
 */
export function computeRealizedPnl(input: RealizedPnlInput): RealizedPnl {
  const {
    totalBuyNotional,
    realizedCash,
    currentMarkValue,
    netShares,
    marketOutcome,
  } = input;
  const remainingValue = remainingSharesValue({
    netShares,
    currentMarkValue,
    marketOutcome,
  });
  const pnlUsdRaw = realizedCash + remainingValue - totalBuyNotional;
  const pnlUsd = Number.isFinite(pnlUsdRaw) ? roundUsd(pnlUsdRaw) : 0;
  const pnlPct =
    Number.isFinite(totalBuyNotional) && totalBuyNotional > 0
      ? roundPct(pnlUsdRaw / totalBuyNotional)
      : null;
  const redemptionProceeds =
    marketOutcome === "winner" && Number.isFinite(netShares) && netShares > 0
      ? roundUsd(netShares) // $1/share payout
      : 0;
  return {
    pnlUsd,
    pnlPct,
    redemptionProceeds,
  };
}

function remainingSharesValue(input: {
  netShares: number;
  currentMarkValue: number;
  marketOutcome: MarketOutcome;
}): number {
  if (input.marketOutcome === "winner") {
    return Number.isFinite(input.netShares) && input.netShares > 0
      ? input.netShares // 1 USDC/share for winning binary token
      : 0;
  }
  if (input.marketOutcome === "loser") return 0;
  return Number.isFinite(input.currentMarkValue) ? input.currentMarkValue : 0;
}

function roundPct(value: number): number {
  const m = 10 ** PCT_DECIMALS;
  return Math.round(value * m) / m;
}

function roundUsd(value: number): number {
  const m = 10 ** USD_DECIMALS;
  return Math.round(value * m) / m;
}
