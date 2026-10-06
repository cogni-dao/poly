// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact-count coverage contract and bounded-sample materialization. */
import {
  WalletDashboardComparisonCoverageLeafSchema,
  type WalletExecutionMarketGroup,
  type WalletExecutionPosition,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";
import {
  materializeComparisonCoverage,
  unavailableComparisonCoverage,
} from "@/features/wallet-analysis/server/market-exposure-service";

function group(input: {
  conditionId: string;
  status: "live" | "closed";
  edgeGapPct: number | null;
}): WalletExecutionMarketGroup {
  return {
    groupKey: `condition:${input.conditionId}`,
    status: input.status,
    edgeGapPct: input.edgeGapPct,
    lines: [
      {
        conditionId: input.conditionId,
        status: input.status,
        edgeGapPct: input.edgeGapPct,
      },
    ],
  } as WalletExecutionMarketGroup;
}

function position(
  conditionId: string,
  status: "live" | "closed"
): WalletExecutionPosition {
  return {
    conditionId,
    status: status === "live" ? "open" : "closed",
  } as WalletExecutionPosition;
}

describe("wallet dashboard comparison coverage", () => {
  it("rejects contradictory, duplicate, and false-unavailable reason states", () => {
    const complete = {
      eligible: 2,
      comparable: 2,
      dropped: 0,
      sampled: 2,
      complete: true,
      reasons: [],
    };
    expect(WalletDashboardComparisonCoverageLeafSchema.safeParse(complete).success).toBe(true);
    expect(
      WalletDashboardComparisonCoverageLeafSchema.safeParse({
        ...complete,
        complete: false,
        reasons: ["preview_truncated", "preview_truncated"],
      }).success
    ).toBe(false);
    expect(
      WalletDashboardComparisonCoverageLeafSchema.safeParse({
        ...complete,
        complete: false,
        reasons: ["source_unavailable"],
      }).success
    ).toBe(false);
    expect(
      WalletDashboardComparisonCoverageLeafSchema.safeParse({
        ...complete,
        eligible: 3,
      }).success
    ).toBe(false);
    expect(
      WalletDashboardComparisonCoverageLeafSchema.safeParse({
        eligible: null,
        comparable: null,
        dropped: null,
        sampled: null,
        complete: false,
        reasons: ["source_unavailable"],
      }).success
    ).toBe(true);
  });

  it("keeps exact population counts separate from finite emitted samples", () => {
    const coverage = materializeComparisonCoverage({
      counts: [
        { entity: "markets", status: "live", eligible: 4, comparable: 3, ambiguous: 1, source_ambiguous: false },
        { entity: "markets", status: "closed", eligible: 0, comparable: 0, ambiguous: 0, source_ambiguous: false },
        { entity: "positions", status: "live", eligible: 5, comparable: 3, ambiguous: 1, source_ambiguous: false },
        { entity: "positions", status: "closed", eligible: 0, comparable: 0, ambiguous: 0, source_ambiguous: false },
      ],
      groups: [
        group({ conditionId: "COND-A", status: "live", edgeGapPct: 0.1 }),
        group({ conditionId: "cond-b", status: "live", edgeGapPct: Number.NaN }),
      ],
      livePositions: [
        position("cond-a", "live"),
        position("COND-B", "live"),
      ],
      closedPositions: [],
      sourceComplete: false,
      previewTruncated: true,
    });

    expect(coverage.markets.live).toEqual({
      eligible: 4,
      comparable: 3,
      dropped: 1,
      sampled: 0,
      complete: false,
      reasons: [
        "source_incomplete",
        "comparison_missing",
        "identity_ambiguous",
        "preview_truncated",
      ],
    });
    expect(coverage.positions.live.sampled).toBe(0);
    expect(coverage.positions.live.eligible).toBe(5);
  });

  it("uses null counts instead of fabricated zeroes when the source fails", () => {
    const coverage = unavailableComparisonCoverage();
    expect(coverage.positions.live).toEqual({
      eligible: null,
      comparable: null,
      dropped: null,
      sampled: null,
      complete: false,
      reasons: ["source_unavailable"],
    });
  });
});
