// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `dashboard-missing-state.spec`
 * Purpose: Acceptance proof that missing dashboard read models never render as
 *   an empty wallet, a cash-only Total, or zero live positions.
 * Scope: Dashboard component composition with query hooks and visual children
 *   mocked. No HTTP, database, wallet, or chain IO.
 * Invariants: UNKNOWN_IS_NOT_ZERO, MISSING_MODEL_IS_NOT_EMPTY.
 * Side-effects: none
 * Links: task.5344, task.5346
 * @vitest-environment jsdom
 */

import { render, screen } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  overview: undefined as unknown,
  execution: undefined as unknown,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    isPending: false,
    mutate: vi.fn(),
    variables: undefined,
  }),
  useQuery: () => ({
    data: { connected: true, trading_ready: true },
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/app/(app)/dashboard/_hooks/useTradingWalletOverview", () => ({
  useTradingWalletOverview: () => ({
    data: state.overview,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/app/(app)/dashboard/_hooks/useDashboardExecution", () => ({
  useDashboardExecution: () => ({
    data: state.execution,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/app/(app)/dashboard/_api/fetchPositionActions", () => ({
  postClosePosition: vi.fn(),
  postRedeemPosition: vi.fn(),
}));

vi.mock("@/components", () => ({
  AddressChip: ({ address }: { address: string }) => <span>{address}</span>,
  Card: ({ children }: { children: ReactNode }) => (
    <section>{children}</section>
  ),
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  ToggleGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ToggleGroupItem: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/features/wallet-analysis", () => ({
  BalanceBar: () => <div>balance bar</div>,
  TimeWindowHeader: () => <div>time window</div>,
  WalletProfitLossCard: () => <div>pnl chart</div>,
}));

vi.mock("@/app/(app)/_components/markets-table", () => ({
  MarketsDeltaDistribution: () => <div>market distribution</div>,
  MarketsTable: () => <div>markets table</div>,
  PositionsDeltaDistribution: () => <div>position distribution</div>,
}));

vi.mock("@/app/(app)/_components/positions-table", () => ({
  PositionsTable: ({
    positions,
    emptyMessage,
  }: {
    positions: unknown[];
    emptyMessage: string;
  }) => <div>{positions.length === 0 ? emptyMessage : "position rows"}</div>,
}));

import { ExecutionActivityCard } from "@/app/(app)/dashboard/_components/ExecutionActivityCard";
import { TradingWalletCard } from "@/app/(app)/dashboard/_components/TradingWalletCard";

describe("dashboard missing read-model states", () => {
  it("shows known cash but withholds Total and the empty-wallet CTA", () => {
    state.overview = {
      configured: true,
      connected: true,
      freshness: "live",
      address: "0x1111111111111111111111111111111111111111",
      interval: "1W",
      capturedAt: "2026-10-02T12:00:00.000Z",
      pol_gas: 1,
      usdc_available: 3.78,
      usdc_locked: 0,
      usdc_positions_mtm: null,
      usdc_total: null,
      open_orders: 0,
      positions_synced_at: null,
      positions_sync_age_ms: null,
      positions_stale: false,
      pnlHistory: [],
      warnings: [
        {
          code: "current_positions_wallet_missing",
          message: "observer missing",
        },
        {
          code: "pnl_history_wallet_missing",
          message: "pnl observer missing",
        },
      ],
    };

    render(<TradingWalletCard />);

    expect(screen.getByText("$3.78")).toBeInTheDocument();
    expect(screen.getByText("Total").parentElement).toHaveTextContent("Total—");
    expect(screen.queryByText(/Wallet is empty/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Total is withheld until holdings are known/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/P\/L history is unavailable until/i)
    ).toBeInTheDocument();
  });

  it("does not label an unavailable POL reading as no gas", () => {
    state.overview = {
      configured: true,
      connected: true,
      freshness: "read_model",
      address: "0x1111111111111111111111111111111111111111",
      interval: "1W",
      capturedAt: "2026-10-02T12:00:00.000Z",
      pol_gas: null,
      usdc_available: null,
      usdc_locked: null,
      usdc_positions_mtm: null,
      usdc_total: null,
      open_orders: null,
      positions_synced_at: null,
      positions_sync_age_ms: null,
      positions_stale: false,
      pnlHistory: [],
      warnings: [{ code: "balances_stale", message: "balance unavailable" }],
    };

    render(<TradingWalletCard />);

    expect(screen.queryByText("no gas")).not.toBeInTheDocument();
    expect(screen.queryByText("low gas")).not.toBeInTheDocument();
  });

  it("explains stale P/L as stale rather than observer-missing", () => {
    state.overview = {
      configured: true,
      connected: true,
      freshness: "read_model",
      address: "0x1111111111111111111111111111111111111111",
      interval: "1W",
      capturedAt: "2026-10-02T12:00:00.000Z",
      pol_gas: 1,
      usdc_available: 3.78,
      usdc_locked: 0,
      usdc_positions_mtm: 45.49,
      usdc_total: 49.27,
      open_orders: 0,
      positions_synced_at: "2026-10-02T12:00:00.000Z",
      positions_sync_age_ms: 0,
      positions_stale: false,
      pnlHistory: [],
      warnings: [{ code: "pnl_history_stale", message: "stale" }],
    };

    render(<TradingWalletCard />);

    expect(screen.getByText(/saved observation is stale/i)).toBeInTheDocument();
    expect(screen.queryByText(/until this trading wallet is present/i)).not.toBeInTheDocument();
  });

  it.each([
    "current_positions_wallet_missing",
    "current_positions_stale",
  ])(
    "renders %s live positions as unavailable, not Live(0) or empty",
    (warningCode) => {
      state.execution = {
        address: "0x1111111111111111111111111111111111111111",
        freshness: "live",
        capturedAt: "2026-10-02T12:00:00.000Z",
        dailyTradeCounts: [],
        live_positions: [],
        market_groups: [],
        closed_positions: [],
        warnings: [{ code: warningCode, message: "position model unavailable" }],
      };

      render(<ExecutionActivityCard />);

      expect(
        screen.getByRole("button", { name: /Live.*—/i })
      ).toBeInTheDocument();
      expect(
        screen.getByText("Open positions unavailable.")
      ).toBeInTheDocument();
      expect(screen.queryByText("No open positions.")).not.toBeInTheDocument();
      expect(
        screen.getByText(/This is not a zero-position result/i)
      ).toBeInTheDocument();
    }
  );
});
