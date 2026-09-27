// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/unit/bootstrap/mirror-exploration-gate`
 * Purpose: Prove t1's live-money safety gate — `buildMirrorTargetConfig` attaches randomized entry ONLY when the executor is the paper sidecar, and never to the self-contained sizing policies whose measurement it would corrupt.
 * Scope: The `exploration` field of the built config. Does NOT re-test sizing-policy resolution.
 * Invariants proven:
 *   - EXPLORATION_IS_PAPER_ONLY — absent unless `paperEnforced === true`. This is the assertion that stands between randomization and real USDC.
 *   - EXPLORATION_SKIPS_SELF_CONTAINED — `mirror_fill_exact` / `position_gap` exist to measure verbatim / gap-proportional mirroring; flipping their entries corrupts that measurement.
 * Side-effects: none
 * Links: app/src/bootstrap/jobs/copy-trade-mirror.job.ts, app/src/bootstrap/container.ts (paperEnforced wiring)
 * @internal
 */

import { describe, expect, it } from "vitest";
import { buildMirrorTargetConfig } from "@/bootstrap/jobs/copy-trade-mirror.job";
import { TOP_TARGET_SIZE_SNAPSHOTS } from "@/features/copy-trade/target-percentile-snapshots";

/** A curated wallet so `sizingPolicyKind: 'auto'` resolves to target_percentile_scaled. */
const CURATED = Object.keys(TOP_TARGET_SIZE_SNAPSHOTS)[0] as `0x${string}`;
/** Not in the snapshot registry ⇒ 'auto' falls back to min_bet. */
const UNCURATED = "0x9999999999999999999999999999999999999999" as const;

function build(
  over: Partial<Parameters<typeof buildMirrorTargetConfig>[0]> = {}
) {
  return buildMirrorTargetConfig({
    targetWallet: CURATED,
    billingAccountId: "ba_test",
    createdByUserId: "user_test",
    ...over,
  });
}

describe("EXPLORATION_IS_PAPER_ONLY", () => {
  it("attaches exploration when the deploy is paper-enforced", () => {
    expect(build({ paperEnforced: true }).exploration).toEqual({
      enabled: true,
      epsilon: 0.1,
    });
  });

  it("omits exploration when paperEnforced is false", () => {
    expect(build({ paperEnforced: false }).exploration).toBeUndefined();
  });

  it("omits exploration when paperEnforced is not passed at all", () => {
    // The live-money default. A caller that forgets the flag gets the
    // deterministic policy, never a randomized one.
    expect(build().exploration).toBeUndefined();
  });

  it("is off for every non-true value a sloppy caller might pass", () => {
    for (const v of [undefined, false, null, 0, "", "paper"] as unknown[]) {
      expect(
        build({ paperEnforced: v as boolean | undefined }).exploration
      ).toBeUndefined();
    }
  });
});

describe("EXPLORATION_SKIPS_SELF_CONTAINED", () => {
  it("omits exploration for mirror_fill_exact even under paper", () => {
    const cfg = build({
      paperEnforced: true,
      sizingPolicyKind: "mirror_fill_exact",
    });
    expect(cfg.sizing.kind).toBe("mirror_fill_exact");
    expect(cfg.exploration).toBeUndefined();
  });

  it("omits exploration for position_gap even under paper", () => {
    const cfg = build({
      paperEnforced: true,
      sizingPolicyKind: "position_gap",
      targetRangeMaxUsdc: 5000,
      mirrorMaxAllocPerConditionUsdc: 25,
    });
    expect(cfg.sizing.kind).toBe("position_gap");
    expect(cfg.exploration).toBeUndefined();
  });

  it("attaches exploration for min_bet on an uncurated wallet under paper", () => {
    const cfg = build({ targetWallet: UNCURATED, paperEnforced: true });
    expect(cfg.sizing.kind).toBe("min_bet");
    expect(cfg.exploration).toEqual({ enabled: true, epsilon: 0.1 });
  });
});
