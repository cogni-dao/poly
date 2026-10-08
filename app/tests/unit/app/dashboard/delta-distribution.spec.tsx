// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `delta-distribution.spec`
 * Purpose: Prove dashboard delta histograms remain visible for bounded empty
 *   samples and sanitize saved comparison values without suppressing the chart.
 * Scope: Pure adapters plus presentational rendering with inert chart doubles.
 * Invariants: HISTOGRAM_ALWAYS_VISIBLE, FINITE_VALUES_ONLY,
 *   JOIN_BY_CANONICAL_CONDITION_ID.
 * Side-effects: none
 * Links: bug.5026
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => ({
  Bar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/vendor/shadcn/chart", () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

import { DeltaDistribution } from "@/app/(app)/_components/markets-table/DeltaDistribution";
import { marketDeltaValues } from "@/app/(app)/_components/markets-table/MarketsDeltaDistribution";
import { positionDeltaValues } from "@/app/(app)/_components/markets-table/PositionsDeltaDistribution";

describe("dashboard delta histogram inputs", () => {
  it("keeps the histogram mounted for an empty bounded sample", () => {
    render(<DeltaDistribution absDeltaPcts={[]} subtitle="live" />);

    expect(screen.getByText("|Δ| distribution")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(screen.queryByText(/mean/i)).not.toBeInTheDocument();
  });

  it("uses every finite market delta and ignores malformed values", () => {
    const values = marketDeltaValues(
      [
        { status: "live", edgeGapPct: 0.1 },
        { status: "live", edgeGapPct: -0.02 },
        { status: "live", edgeGapPct: Number.NaN },
        { status: "closed", edgeGapPct: 0.5 },
      ] as never,
      "live"
    );

    expect(values).toEqual([10, 2]);
  });

  it("joins positions case-insensitively and excludes ambiguous lines", () => {
    const values = positionDeltaValues(
      [{ conditionId: "CONDITION-A" }, { conditionId: "condition-b" }] as never,
      [
        {
          lines: [
            { conditionId: "condition-a", status: "live", edgeGapPct: 0.1 },
            { conditionId: "condition-b", status: "live", edgeGapPct: 0.2 },
            { conditionId: "CONDITION-B", status: "live", edgeGapPct: 0.3 },
          ],
        },
      ] as never,
      "live"
    );

    expect(values).toEqual([10]);
  });
});
