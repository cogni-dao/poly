// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/unit/features/copy-trade/plan-mirror-exploration`
 * Purpose: Prove the t1 ε-flip randomized-entry policy in `planMirrorFromFill` — exact propensities, correct eligibility narrowing, and preserved purity. FIRST tests for this planner; it previously had none.
 * Scope: The exploration seam only. Does NOT re-test pXX sizing, dominance, VWAP, or follow-up branches beyond asserting they stay deterministic.
 * Invariants proven:
 *   - PROPENSITY_IS_EXACT — greedy ⇒ `1-ε`, explore ⇒ `ε`. Not estimated, not approximated.
 *   - EXPLORATION_IS_ENTRY_ONLY — follow-up branches and non-pXX skips never carry an arm.
 *   - PLAN_IS_PURE — the draw is injected; same input ⇒ same output.
 *   - NO_DRAW_MEANS_DETERMINISTIC — a caller that forgets to draw degrades to greedy WITHOUT logging a propensity, rather than randomizing unlogged.
 * Side-effects: none
 * Links: app/src/features/copy-trade/plan-mirror.ts, packages/poly-db-schema/src/copy-trade.ts (exploration_arm/propensity)
 * @internal
 */

import type { Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import { planMirrorFromFill } from "@/features/copy-trade/plan-mirror";
import type {
  MirrorTargetConfig,
  PlanMirrorInput,
  RuntimeState,
} from "@/features/copy-trade/types";

const TARGET_WALLET = "0x1111111111111111111111111111111111111111";
const ASSET = "77777777777777777777777777777777777777777777777777";
const CONDITION = "0xabc123";
const COID = `0x${"ab".repeat(32)}` as `0x${string}`;

/** The mirrored fill itself. Its notional does NOT drive the pXX gate. */
function fillFor(): Fill {
  return {
    target_wallet: TARGET_WALLET,
    fill_id: `data-api:0xdead:${ASSET}:BUY:1750000000`,
    source: "data-api",
    market_id: `prediction-market:polymarket:${CONDITION}`,
    outcome: "Yes",
    side: "BUY",
    price: 0.5,
    size_usdc: 10,
    observed_at: "2026-09-26T00:00:00.000Z",
    attributes: { asset: ASSET, condition_id: CONDITION },
  };
}

/**
 * pXX gate at $200 (RN1's p75). `target_percentile` — the simplest policy that
 * produces `below_target_percentile`, so the eligibility boundary is unambiguous.
 */
function configWith(
  exploration: MirrorTargetConfig["exploration"]
): MirrorTargetConfig {
  return {
    target_id: "00000000-0000-4000-8000-000000000001",
    target_wallet: TARGET_WALLET,
    billing_account_id: "ba_test",
    created_by_user_id: "user_test",
    sizing: {
      kind: "target_percentile",
      max_usdc_per_condition: 25,
      statistic: {
        wallet: TARGET_WALLET,
        label: "p75",
        captured_at: "2026-05-03T02:34:00.000Z",
        sample_size: 3990,
        min_target_usdc: 200,
        max_target_usdc: 5659,
        percentile: 75,
      },
    },
    placement: { kind: "mirror_limit" },
    ...(exploration ? { exploration } : {}),
  } as MirrorTargetConfig;
}

/**
 * `target_percentile` gates on the TARGET's cost basis on the fill's token
 * (`targetSizingUsdcForFill` -> `targetTokenCostUsdc`), not on `fill.size_usdc`.
 * Getting this wrong makes every fill skip, which is exactly the trap this
 * helper exists to remove for the next test author.
 */
function stateWithTargetCost(costUsdc: number): RuntimeState {
  return {
    already_placed_ids: [],
    placed_fill_ids: [],
    target_position: {
      condition_id: CONDITION,
      tokens: [
        {
          token_id: ASSET,
          size_shares: costUsdc * 2,
          cost_usdc: costUsdc,
          current_value_usdc: costUsdc,
        },
      ],
    },
  };
}

function plan(
  targetCostUsdc: number,
  exploration: MirrorTargetConfig["exploration"],
  draw: number | undefined
) {
  const input: PlanMirrorInput = {
    fill: fillFor(),
    config: configWith(exploration),
    state: stateWithTargetCost(targetCostUsdc),
    client_order_id: COID,
    min_usdc_notional: 1,
    min_shares: 5,
    ...(draw === undefined ? {} : { exploration_draw: draw }),
  };
  return planMirrorFromFill(input);
}

const EPS = { enabled: true, epsilon: 0.1 } as const;

// Target cost basis vs the $200 p75 gate: $50 ⇒ greedy skips, $1000 ⇒ greedy places.
const BELOW = 50;
const ABOVE = 1000;

describe("plan-mirror exploration: baseline is deterministic", () => {
  it("skips below pXX and places above it with no exploration metadata", () => {
    const lo = plan(BELOW, undefined, undefined);
    const hi = plan(ABOVE, undefined, undefined);
    expect(lo.kind).toBe("skip");
    expect(lo.kind === "skip" && lo.reason).toBe("below_target_percentile");
    expect(hi.kind).toBe("place");
    expect(lo.exploration).toBeUndefined();
    expect(hi.exploration).toBeUndefined();
  });
});

describe("plan-mirror exploration: ε-flip propensities are exact", () => {
  it("greedy arm keeps the deterministic action with propensity 1-ε", () => {
    // draw >= ε ⇒ greedy
    const lo = plan(BELOW, EPS, 0.9);
    const hi = plan(ABOVE, EPS, 0.9);
    expect(lo.kind).toBe("skip");
    expect(hi.kind).toBe("place");
    for (const p of [lo, hi]) {
      expect(p.exploration).toEqual({ arm: "greedy", propensity: 0.9 });
    }
  });

  it("explore arm flips skip→place and place→skip with propensity ε", () => {
    // draw < ε ⇒ explore
    const flipUp = plan(BELOW, EPS, 0.01);
    const flipDown = plan(ABOVE, EPS, 0.01);
    expect(flipUp.kind).toBe("place");
    expect(flipDown.kind).toBe("skip");
    for (const p of [flipUp, flipDown]) {
      expect(p.exploration).toEqual({ arm: "explore", propensity: 0.1 });
    }
  });

  it("propensities of the two arms sum to 1 over the binary action set", () => {
    const greedy = plan(BELOW, EPS, 0.5)?.exploration?.propensity ?? 0;
    const explore = plan(BELOW, EPS, 0.0)?.exploration?.propensity ?? 0;
    expect(greedy + explore).toBeCloseTo(1, 12);
  });

  it("an explore-flip probes at the market floor, not the pXX-scaled notional", () => {
    const flipped = plan(BELOW, EPS, 0.01);
    // min_usdc_notional=1, min_shares=5, price=0.5 ⇒ floor = max(5*0.5, 1) = 2.5
    expect(flipped.kind === "place" && flipped.intent.size_usdc).toBeCloseTo(
      2.5,
      6
    );
  });

  it("the boundary draw == ε is greedy, not explore", () => {
    // Half-open [0, ε) is the explore region; ε itself must not flip.
    expect(plan(BELOW, EPS, 0.1)?.exploration?.arm).toBe("greedy");
    expect(plan(BELOW, EPS, 0.09999999)?.exploration?.arm).toBe("explore");
  });
});

describe("plan-mirror exploration: eligibility is narrow and fail-safe", () => {
  it("logs nothing when the policy is disabled", () => {
    expect(plan(BELOW, { enabled: false, epsilon: 0.1 }, 0.01).exploration)
      .toBeUndefined();
  });

  it("treats ε=0 as disabled rather than logging a degenerate propensity of 1", () => {
    expect(
      plan(BELOW, { enabled: true, epsilon: 0 }, 0.0).exploration
    ).toBeUndefined();
  });

  it("degrades to deterministic when the caller supplies no draw", () => {
    const p = plan(BELOW, EPS, undefined);
    expect(p.kind).toBe("skip");
    expect(p.exploration).toBeUndefined();
  });

  it("ignores an out-of-range draw instead of randomizing on garbage", () => {
    for (const bad of [-0.1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(plan(BELOW, EPS, bad).exploration).toBeUndefined();
    }
  });

  it("never flips a hard gate — already_placed stays a deterministic skip", () => {
    const input: PlanMirrorInput = {
      fill: fillFor(),
      config: configWith(EPS),
      state: { ...stateWithTargetCost(BELOW), already_placed_ids: [COID] },
      client_order_id: COID,
      min_usdc_notional: 1,
      min_shares: 5,
      exploration_draw: 0.0, // would explore if it were eligible
    };
    const p = planMirrorFromFill(input);
    expect(p.kind === "skip" && p.reason).toBe("already_placed");
    expect(p.exploration).toBeUndefined();
  });
});

describe("plan-mirror exploration: purity", () => {
  it("is deterministic given the same injected draw", () => {
    const a = plan(BELOW, EPS, 0.05);
    const b = plan(BELOW, EPS, 0.05);
    expect(a).toEqual(b);
  });

  it("does not consult a global RNG — distinct draws are the only variation source", () => {
    const arms = [0.0, 0.05, 0.2, 0.9].map(
      (d) => plan(BELOW, EPS, d).exploration?.arm
    );
    expect(arms).toEqual(["explore", "explore", "greedy", "greedy"]);
  });
});
