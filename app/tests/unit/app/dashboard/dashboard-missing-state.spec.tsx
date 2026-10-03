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

import { fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("@/components", async () => {
  const React = await import("react");
  const ToggleGroupContext = React.createContext<
    ((value: string) => void) | undefined
  >(undefined);

  return {
    AddressChip: ({ address }: { address: string }) => <span>{address}</span>,
    Card: ({ children }: { children: ReactNode }) => (
      <section>{children}</section>
    ),
    CardContent: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    CardHeader: ({ children }: { children: ReactNode }) => (
      <header>{children}</header>
    ),
    CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
    ToggleGroup: ({
      children,
      onValueChange,
    }: {
      children: ReactNode;
      onValueChange?: (value: string) => void;
    }) => (
      <ToggleGroupContext.Provider value={onValueChange}>
        <div>{children}</div>
      </ToggleGroupContext.Provider>
    ),
    ToggleGroupItem: ({
      children,
      value,
      ...props
    }: ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) => {
      const onValueChange = React.useContext(ToggleGroupContext);
      return (
        <button
          type="button"
          {...props}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      );
    },
  };
});

vi.mock("@/features/wallet-analysis", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/features/wallet-analysis")
  >();
  return {
    ...actual,
    BalanceBar: () => <div>balance bar</div>,
    TimeWindowHeader: () => <div>time window</div>,
    TradesPerDayChart: () => <div>trade volume chart</div>,
  };
});

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
import { OperatorWalletChartsRow } from "@/app/(app)/dashboard/_components/OperatorWalletChartsRow";
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
    expect(
      screen.queryByText(/until this trading wallet is present/i)
    ).not.toBeInTheDocument();
    // Use the real WalletProfitLossCard here: stale availability must prevent
    // its empty-series fallback from contradicting the explicit stale state.
    expect(screen.queryByText("No P/L history yet.")).not.toBeInTheDocument();
  });

  it("explains a P/L read failure without claiming observer absence", () => {
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
      warnings: [{ code: "pnl_history_unavailable", message: "read failed" }],
    };

    render(<TradingWalletCard />);

    expect(screen.getByText(/saved read failed/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/until this trading wallet is present/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText("No P/L history yet.")).not.toBeInTheDocument();
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

  it("labels a bounded position preview without calling it an upstream failure", () => {
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      live_position_count: 501,
      market_groups: [],
      closed_positions: [],
      warnings: [
        {
          code: "positions_preview_truncated",
          message: "Showing 500 of 501 open positions.",
        },
      ],
    };

    render(<ExecutionActivityCard />);

    expect(screen.getByRole("button", { name: /Live.*501/i })).toBeInTheDocument();
    expect(screen.getByText(/bounded preview/i)).toBeInTheDocument();
    expect(screen.queryByText(/upstream data is temporarily unavailable/i)).not.toBeInTheDocument();
  });

  it.each([
    [
      "wallet_adapter_unconfigured",
      /execution is unavailable on this deployment/i,
    ],
    ["no_trading_wallet", /Connect a trading wallet from Money/i],
  ])("renders %s as unavailable instead of empty execution", (code, copy) => {
    state.execution = {
      address: "0x0000000000000000000000000000000000000000",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      market_groups: [],
      closed_positions: [],
      warnings: [{ code, message: "unavailable" }],
    };

    render(<ExecutionActivityCard />);

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText("No open positions.")).not.toBeInTheDocument();
  });

  it("renders unavailable closed history as unknown rather than zero", () => {
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      live_position_count: 0,
      market_groups: [],
      closed_positions: [],
      warnings: [
        { code: "positions_read_model_unavailable", message: "read failed" },
      ],
    };

    render(<ExecutionActivityCard />);
    fireEvent.click(screen.getByRole("button", { name: /Closed/i }));

    expect(screen.getByRole("button", { name: /Closed.*—/i })).toBeInTheDocument();
    expect(screen.getByText(/not a zero-history result/i)).toBeInTheDocument();
    expect(
      screen.getByText("Closed position history unavailable.")
    ).toBeInTheDocument();
    expect(screen.queryByText("No closed positions yet.")).not.toBeInTheDocument();
  });

  it("suppresses false-zero market visuals when exposure is unavailable", () => {
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      live_position_count: 0,
      market_groups: [],
      closed_positions: [],
      warnings: [
        { code: "market_exposure_unavailable", message: "read failed" },
      ],
    };

    render(<ExecutionActivityCard />);
    fireEvent.click(screen.getByRole("button", { name: "Markets" }));

    expect(screen.getByText(/not a zero-exposure result/i)).toBeInTheDocument();
    expect(screen.queryByText("market distribution")).not.toBeInTheDocument();
    expect(screen.queryByText("markets table")).not.toBeInTheDocument();
  });

  it.each([
    ["wallet_adapter_unconfigured", /history is unavailable on this deployment/i],
    ["no_trading_wallet", /Connect a trading wallet from Money/i],
    ["daily_trade_counts_unavailable", /not a zero-trade result/i],
  ])("does not call %s an empty trade history", (code, copy) => {
    state.execution = {
      address: "0x0000000000000000000000000000000000000000",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      market_groups: [],
      closed_positions: [],
      warnings: [{ code, message: "unavailable" }],
    };

    render(<OperatorWalletChartsRow />);

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText("No trade history yet.")).not.toBeInTheDocument();
  });
});
