// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `delta-coverage.spec`
 * Purpose: Prove dashboard delta charts expose exact population coverage and
 *   fail closed for incomplete or ambiguous comparisons.
 * Scope: Pure/jsdom dashboard components; no HTTP, database, or upstream IO.
 * Invariants: UNKNOWN_IS_NOT_ZERO, DROPPED_IS_VISIBLE, IDENTITY_AMBIGUITY_FAILS_CLOSED.
 * Side-effects: none
 * @vitest-environment jsdom
 */

import type {
  WalletDashboardComparisonCoverageLeaf,
  WalletExecutionMarketGroup,
} from "@cogni/poly-node-contracts";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { DeltaDistribution } from "@/app/(app)/_components/markets-table/DeltaDistribution";
import { MarketsDeltaDistribution } from "@/app/(app)/_components/markets-table/MarketsDeltaDistribution";
import { PositionsDeltaDistribution } from "@/app/(app)/_components/markets-table/PositionsDeltaDistribution";
import type { WalletPosition } from "@/features/wallet-analysis";

vi.mock("recharts", () => ({
  Bar: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Cell: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/vendor/shadcn/chart", () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="delta-chart">{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

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
  groupStatus: "live" | "closed";
  groupDelta: number | null;
  groupKey?: string;
  lines?: readonly {
    conditionId: string;
    status: "live" | "closed";
    edgeGapPct: number | null;
  }[];
}): WalletExecutionMarketGroup {
  return {
    groupKey: args.groupKey ?? `${args.groupStatus}-group`,
    status: args.groupStatus,
    edgeGapPct: args.groupDelta,
    lines: args.lines ?? [],
  } as unknown as WalletExecutionMarketGroup;
}

function position(conditionId: string): WalletPosition {
  return { conditionId } as unknown as WalletPosition;
}

describe("DeltaDistribution coverage states", () => {
  it("renders complete full-population coverage and a genuine zero delta", () => {
    render(
      <DeltaDistribution
        absDeltaPcts={[0]}
        subtitle="live"
        entityLabel="positions"
        coverage={coverage()}
      />
    );

    expect(
      screen.getByText("Compared 1 of 1 positions · 0 excluded")
    ).toBeInTheDocument();
    expect(screen.getAllByText("0.0%")).toHaveLength(2);
    expect(screen.getByTestId("delta-chart")).toBeInTheDocument();
    expect(screen.queryByText(/Partial comparison/i)).not.toBeInTheDocument();
  });

  it("labels dropped rows and a bounded chart sample as partial", () => {
    render(
      <DeltaDistribution
        absDeltaPcts={[2, 8]}
        subtitle="live"
        entityLabel="positions"
        coverage={coverage({
          eligible: 5,
          comparable: 4,
          dropped: 1,
          sampled: 2,
          complete: false,
          reasons: ["comparison_missing", "preview_truncated"],
        })}
      />
    );

    expect(
      screen.getByText("Compared 4 of 5 positions · 1 excluded")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "Chart sample 2 of 4"
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      /Partial comparison.*missing.*bounded preview/i
    );
  });

  it("renders unavailable counts as unknown and suppresses the histogram", () => {
    render(
      <DeltaDistribution
        absDeltaPcts={[]}
        subtitle="closed"
        entityLabel="markets"
        coverage={coverage({
          eligible: null,
          comparable: null,
          dropped: null,
          sampled: null,
          complete: false,
          reasons: ["source_unavailable"],
        })}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Delta comparison unavailable.*coverage unavailable/i
    );
    expect(screen.queryByTestId("delta-chart")).not.toBeInTheDocument();
  });

  it("distinguishes a true empty population from unavailable", () => {
    render(
      <DeltaDistribution
        absDeltaPcts={[]}
        subtitle="closed"
        entityLabel="positions"
        coverage={coverage({
          eligible: 0,
          comparable: 0,
          dropped: 0,
          sampled: 0,
        })}
      />
    );

    expect(
      screen.getByText("No eligible closed positions.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
  });

  it("marks a stale or incomplete source partial even with zero dropped rows", () => {
    render(
      <DeltaDistribution
        absDeltaPcts={[4]}
        subtitle="live"
        entityLabel="markets"
        coverage={coverage({
          sampled: 0,
          complete: false,
          reasons: ["source_incomplete", "preview_truncated"],
        })}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Partial comparison.*Chart sample 0 of 1.*withheld.*stale or incomplete.*bounded preview/i
    );
    expect(screen.queryByTestId("delta-chart")).not.toBeInTheDocument();
  });

  it("keeps a truncated sample partial when no population row was dropped", () => {
    render(
      <DeltaDistribution
        absDeltaPcts={[4]}
        subtitle="live"
        entityLabel="markets"
        coverage={coverage({
          eligible: 2,
          comparable: 2,
          dropped: 0,
          sampled: 1,
          complete: false,
          reasons: ["preview_truncated"],
        })}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Partial comparison.*bounded preview/i
    );
    expect(
      screen.getByText("Compared 2 of 2 markets · 0 excluded")
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, element) => element?.textContent === "Chart sample 1 of 2"
      )
    ).toBeInTheDocument();
  });

  it.each([
    [
      "population invariant",
      coverage({ eligible: 3, comparable: 1, dropped: 1, sampled: 1 }),
      [4],
    ],
    ["sample invariant", coverage(), []],
  ])("fails closed for a malformed %s", (_label, leaf, sample) => {
    render(
      <DeltaDistribution
        absDeltaPcts={sample}
        subtitle="live"
        entityLabel="markets"
        coverage={leaf}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Delta comparison unavailable/i
    );
    expect(screen.queryByTestId("delta-chart")).not.toBeInTheDocument();
  });

  it("fails closed when coverage is absent", () => {
    render(
      <DeltaDistribution
        absDeltaPcts={[4]}
        subtitle="live"
        entityLabel="markets"
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Delta comparison unavailable.*source is unavailable/i
    );
    expect(screen.queryByTestId("delta-chart")).not.toBeInTheDocument();
  });
});

describe("delta adapter identity and filter behavior", () => {
  it("matches position and market identities case-insensitively", () => {
    render(
      <PositionsDeltaDistribution
        positions={[position("0xABCDEF")]}
        groups={[
          marketGroup({
            groupStatus: "live",
            groupDelta: 0.125,
            lines: [
              {
                conditionId: "0xabcdef",
                status: "live",
                edgeGapPct: 0.125,
              },
            ],
          }),
        ]}
        statusFilter="live"
        coverage={coverage()}
      />
    );

    expect(screen.getAllByText("12.5%")).toHaveLength(2);
    expect(
      screen.getByText("Compared 1 of 1 positions · 0 excluded")
    ).toBeInTheDocument();
  });

  it("fails closed when normalized line identities are duplicated", () => {
    render(
      <PositionsDeltaDistribution
        positions={[position("condition-a")]}
        groups={[
          marketGroup({
            groupStatus: "live",
            groupDelta: 0.1,
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
        ]}
        statusFilter="live"
        coverage={coverage()}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Delta comparison unavailable.*Duplicate wallet or market identities/i
    );
    expect(screen.queryByTestId("delta-chart")).not.toBeInTheDocument();
  });

  it("shows an unmatched position as dropped instead of omitting it", () => {
    render(
      <PositionsDeltaDistribution
        positions={[position("unmatched-condition")]}
        groups={[]}
        statusFilter="live"
        coverage={coverage({
          eligible: 1,
          comparable: 0,
          dropped: 1,
          sampled: 0,
          complete: false,
          reasons: ["comparison_missing"],
        })}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Compared 0 of 1 positions · 1 excluded/i
    );
    expect(screen.queryByTestId("delta-chart")).not.toBeInTheDocument();
  });

  it("uses only selected-status lines for position deltas", () => {
    render(
      <PositionsDeltaDistribution
        positions={[position("condition-a")]}
        groups={[
          marketGroup({
            groupStatus: "live",
            groupDelta: 0.1,
            lines: [
              {
                conditionId: "condition-a",
                status: "live",
                edgeGapPct: 0.1,
              },
              {
                conditionId: "CONDITION-A",
                status: "closed",
                edgeGapPct: 0.2,
              },
            ],
          }),
        ]}
        statusFilter="closed"
        coverage={coverage()}
      />
    );

    expect(screen.getAllByText("20.0%")).toHaveLength(2);
    expect(screen.queryAllByText("10.0%")).toHaveLength(0);
  });

  it("uses only the selected market status for the histogram sample", () => {
    render(
      <MarketsDeltaDistribution
        groups={[
          marketGroup({ groupStatus: "live", groupDelta: 0.05 }),
          marketGroup({ groupStatus: "closed", groupDelta: 0.25 }),
        ]}
        statusFilter="closed"
        coverage={coverage()}
      />
    );

    expect(screen.getAllByText("25.0%")).toHaveLength(2);
    expect(screen.queryAllByText("5.0%")).toHaveLength(0);
  });

  it("fails closed when normalized market group identities are duplicated", () => {
    render(
      <MarketsDeltaDistribution
        groups={[
          marketGroup({
            groupKey: "event-a",
            groupStatus: "live",
            groupDelta: 0.05,
          }),
          marketGroup({
            groupKey: "EVENT-A",
            groupStatus: "live",
            groupDelta: 0.1,
          }),
        ]}
        statusFilter="live"
        coverage={coverage({
          eligible: 2,
          comparable: 2,
          sampled: 2,
        })}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      /Delta comparison unavailable.*Duplicate wallet or market identities/i
    );
    expect(screen.queryByTestId("delta-chart")).not.toBeInTheDocument();
  });
});
