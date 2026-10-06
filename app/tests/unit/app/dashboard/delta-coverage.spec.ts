// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `delta-coverage.spec`
 * Purpose: Mechanical guards for dashboard coverage validation and projection.
 * Scope: Pure functions; no React, HTTP, database, or upstream IO.
 * Invariants: UNKNOWN_IS_NOT_ZERO, DROPPED_IS_VISIBLE, AMBIGUITY_FAILS_CLOSED.
 * Side-effects: none
 */

import type {
  WalletDashboardComparisonCoverageLeaf,
  WalletExecutionMarketGroup,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

import {
  comparisonCoverageReasonText,
  projectMarketDeltaInput,
  projectPositionDeltaInput,
  resolveDeltaCoverageState,
} from "@/app/(app)/dashboard/_components/dashboard-delta-coverage";
import type { WalletPosition } from "@/features/wallet-analysis";

function coverage(
  overrides: Partial<WalletDashboardComparisonCoverageLeaf> = {}
): WalletDashboardComparisonCoverageLeaf {
  return {
    eligible: 1,
    comparable: 1,
    dropped: 0,
    sampled: 1,
    complete: true,
    reasons: [],
    ...overrides,
  };
}

function marketGroup(args: {
  status: "live" | "closed";
  delta: number | null;
  groupKey?: string;
  lines?: readonly {
    conditionId: string;
    status: "live" | "closed";
    edgeGapPct: number | null;
  }[];
}): WalletExecutionMarketGroup {
  return {
    groupKey: args.groupKey ?? `${args.status}-${String(args.delta)}`,
    status: args.status,
    edgeGapPct: args.delta,
    lines: args.lines ?? [],
  } as unknown as WalletExecutionMarketGroup;
}

function position(conditionId: string, asset = "asset-a"): WalletPosition {
  return { conditionId, asset } as unknown as WalletPosition;
}

describe("resolveDeltaCoverageState", () => {
  it("distinguishes complete, true empty, and unavailable", () => {
    expect(
      resolveDeltaCoverageState({ coverage: coverage(), sampleCount: 1 })
        .kind
    ).toBe("complete");
    expect(
      resolveDeltaCoverageState({
        coverage: coverage({
          eligible: 0,
          comparable: 0,
          dropped: 0,
          sampled: 0,
        }),
        sampleCount: 0,
      }).kind
    ).toBe("empty");
    expect(
      resolveDeltaCoverageState({
        coverage: coverage({
          eligible: null,
          comparable: null,
          dropped: null,
          sampled: null,
          complete: false,
          reasons: ["source_unavailable"],
        }),
        sampleCount: 0,
      }).kind
    ).toBe("unavailable");
  });

  it("keeps dropped and truncated comparisons partial", () => {
    const state = resolveDeltaCoverageState({
      coverage: coverage({
        eligible: 5,
        comparable: 4,
        dropped: 1,
        sampled: 2,
        complete: false,
        reasons: ["comparison_missing", "preview_truncated"],
      }),
      sampleCount: 2,
    });
    expect(state.kind).toBe("partial");
    expect(state.counts).toEqual({
      eligible: 5,
      comparable: 4,
      dropped: 1,
      sampled: 2,
    });
  });

  it("withholds incomplete sources and preserves coexisting reasons", () => {
    const state = resolveDeltaCoverageState({
      coverage: coverage({
        sampled: 0,
        complete: false,
        reasons: ["source_incomplete", "preview_truncated"],
      }),
      sampleCount: 1,
    });
    expect(state.kind).toBe("partial");
    expect(state.kind === "partial" && state.suppressChart).toBe(true);
    expect(comparisonCoverageReasonText(state.reasons)).toMatch(
      /stale or incomplete.*bounded preview/i
    );
  });

  it.each([
    {
      leaf: coverage({ eligible: 3, comparable: 1, dropped: 1, sampled: 1 }),
      inputInvalid: false,
    },
    { leaf: coverage({ sampled: 0 }), inputInvalid: false },
    { leaf: coverage(), inputInvalid: true },
  ])("fails closed for malformed counts or input", ({ leaf, inputInvalid }) => {
    const state = resolveDeltaCoverageState({
      coverage: leaf,
      sampleCount: 1,
      inputInvalid,
    });
    expect(state.kind).toBe("unavailable");
    expect(state.invalid).toBe(true);
  });

  it("keeps an unmatched eligible position visible as dropped", () => {
    const state = resolveDeltaCoverageState({
      coverage: coverage({
        eligible: 1,
        comparable: 0,
        dropped: 1,
        sampled: 0,
        complete: false,
        reasons: ["comparison_missing"],
      }),
      sampleCount: 0,
    });
    expect(state.kind).toBe("partial");
    expect(state.counts?.dropped).toBe(1);
  });
});

describe("dashboard delta input projection", () => {
  it("normalizes both sides and selects the requested line status", () => {
    const projected = projectPositionDeltaInput(
      [position("0xABCDEF")],
      [
        marketGroup({
          status: "live",
          delta: 0.1,
          lines: [
            {
              conditionId: "0xABCDEF",
              status: "live",
              edgeGapPct: 0.1,
            },
            {
              conditionId: "0xabcdef",
              status: "closed",
              edgeGapPct: 0.2,
            },
          ],
        }),
      ],
      "closed"
    );
    expect(projected.positions[0]?.conditionId).toBe("0xabcdef");
    expect(projected.groups[0]?.lines[0]?.conditionId).toBe("0xabcdef");
    expect(projected.groups[0]?.lines).toHaveLength(1);
    expect(projected.sampleCount).toBe(1);
    expect(projected.identityAmbiguous).toBe(false);
  });

  it("marks duplicate normalized line identities ambiguous", () => {
    const projected = projectPositionDeltaInput(
      [position("condition-a")],
      [
        marketGroup({
          status: "live",
          delta: 0.1,
          lines: [
            {
              conditionId: "condition-a",
              status: "live",
              edgeGapPct: 0.1,
            },
            {
              conditionId: "CONDITION-A",
              status: "live",
              edgeGapPct: 0.2,
            },
          ],
        }),
      ],
      "live"
    );
    expect(projected.identityAmbiguous).toBe(true);
    expect(projected.sampleCount).toBe(0);
  });

  it("rejects duplicate position identities but permits sibling assets", () => {
    const line = marketGroup({
      status: "live",
      delta: 0.1,
      lines: [
        {
          conditionId: "condition-a",
          status: "live",
          edgeGapPct: 0.1,
        },
      ],
    });
    expect(
      projectPositionDeltaInput(
        [position("condition-a"), position("CONDITION-A")],
        [line],
        "live"
      ).identityAmbiguous
    ).toBe(true);
    expect(
      projectPositionDeltaInput(
        [
          position("condition-a", "asset-a"),
          position("CONDITION-A", "asset-b"),
        ],
        [line],
        "live"
      ).identityAmbiguous
    ).toBe(false);
  });

  it("counts only selected markets and rejects duplicate normalized keys", () => {
    const projected = projectMarketDeltaInput(
      [
        marketGroup({ status: "live", delta: 0.05, groupKey: "event-a" }),
        marketGroup({ status: "live", delta: 0.1, groupKey: "EVENT-A" }),
        marketGroup({ status: "closed", delta: 0.2, groupKey: "event-b" }),
      ],
      "live"
    );
    expect(projected.sampleCount).toBe(2);
    expect(projected.identityAmbiguous).toBe(true);
  });
});
