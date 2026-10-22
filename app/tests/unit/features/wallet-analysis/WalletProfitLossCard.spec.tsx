// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `WalletProfitLossCard.spec`
 * Purpose: Prove a persisted zero P/L point is rendered as real zero data,
 *   rather than the missing-history state.
 * Scope: Presentational unit test; chart primitives are inert test doubles.
 * Invariants: SAVED_ZERO_IS_DATA, HEADLINE_IS_WINDOWED_DELTA.
 * Side-effects: none
 * Links: src/features/wallet-analysis/components/WalletProfitLossCard.tsx
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components", () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

import {
  computeWindowedPnl,
  WalletProfitLossCard,
} from "@/features/wallet-analysis/components/WalletProfitLossCard";

describe("WalletProfitLossCard zero history", () => {
  it("renders one persisted zero point as $0.00, not missing history", () => {
    const history = [{ ts: "2026-10-02T12:00:00.000Z", pnl: 0 }];

    render(<WalletProfitLossCard history={history} interval="1W" />);

    expect(computeWindowedPnl(history)).toBe(0);
    expect(screen.getByText("$0.00")).toBeInTheDocument();
    expect(screen.queryByText("No P/L history yet.")).not.toBeInTheDocument();
    expect(
      screen.getByText(/One P\/L observation recorded/i)
    ).toBeInTheDocument();
  });
});


describe("WalletProfitLossCard recorded paper observations", () => {
  it.each([0, 1.9])("withholds interval change for one actual paper sample %s", (pnl) => {
    render(<WalletProfitLossCard source="paper" history={[{ ts: "2026-10-02T12:00:00.000Z", pnl }]} interval="1W" />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("Past week")).not.toBeInTheDocument();
    expect(screen.getByText(/One P\/L observation recorded/i)).toBeInTheDocument();
    expect(screen.queryByText("No P/L history yet.")).not.toBeInTheDocument();
  });

  it("labels only the change between two genuine samples and their actual range", () => {
    render(<WalletProfitLossCard source="paper" history={[
      { ts: "2026-10-02T23:59:59.125Z", pnl: 1.9 },
      { ts: "2026-10-03T00:00:01.250Z", pnl: 0.9 },
    ]} interval="ALL" />);
    expect(screen.getByText("Change between recorded observations")).toBeInTheDocument();
    expect(screen.getByText("-$1.00")).toBeInTheDocument();
    expect(screen.queryByText("All time")).not.toBeInTheDocument();
    expect(screen.getByText(/complete selected-interval P\/L is unavailable/)).toBeInTheDocument();
  });
});
