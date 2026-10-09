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
  actionsAllowed: true,
  setInterval: vi.fn(),
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

vi.mock("@/app/(app)/dashboard/_hooks/useWalletDashboard", () => ({
  WALLET_DASHBOARD_QUERY_KEY: "dashboard-wallet-snapshot",
  useWalletDashboard: () => ({
    data:
      state.overview === undefined && state.execution === undefined
        ? undefined
        : {
            overview: state.overview,
            execution: state.execution,
            facts: { positions: { actionsAllowed: state.actionsAllowed } },
          },
    isLoading: false,
    isError: false,
    interval: "1W",
    setInterval: state.setInterval,
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
    TimeWindowHeader: ({
      onIntervalChange,
    }: {
      onIntervalChange: (interval: "1D") => void;
    }) => (
      <div data-testid="time-window">
        <button type="button" onClick={() => onIntervalChange("1D")}>
          1D
        </button>
      </div>
    ),
    TradesPerDayChart: ({
      daily,
      bucketUnit,
    }: {
      daily?: readonly { d: string; n: number }[];
      bucketUnit?: string;
    }) => (
      <div data-testid="trade-volume" data-bucket-unit={bucketUnit}>
        {daily?.map((bucket) => `${bucket.d}:${bucket.n}`).join("|")}
      </div>
    ),
  };
});

vi.mock("@/app/(app)/_components/markets-table", () => ({
  MarketsDeltaDistribution: () => <div>market distribution</div>,
  MarketsTable: ({
    onStatusFilterChange,
  }: {
    onStatusFilterChange?: (status: "closed") => void;
  }) => (
    <div>
      markets table
      <button type="button" onClick={() => onStatusFilterChange?.("closed")}>
        Closed markets
      </button>
    </div>
  ),
  PositionsDeltaDistribution: () => <div>position distribution</div>,
}));

vi.mock("@/app/(app)/_components/positions-table", () => ({
  PositionsTable: ({
    positions,
    emptyMessage,
    onPositionAction,
  }: {
    positions: unknown[];
    emptyMessage: string;
    onPositionAction?: unknown;
  }) => (
    <div>
      {positions.length === 0 ? emptyMessage : "position rows"}
      {onPositionAction ? <button type="button">position action</button> : null}
    </div>
  ),
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
    expect(
      screen.getByRole("img", {
        name: /Balance composition; Available: \$3\.78; Locked: \$0\.00; Positions: unavailable; Total: unavailable/i,
      })
    ).toBeInTheDocument();
    expect(screen.getByTitle("Available balance")).toHaveClass("bg-success/70");
    expect(screen.getByTitle("Locked balance")).toHaveClass("bg-warning/70");
    expect(screen.getByTitle("Positions balance")).toHaveClass(
      "bg-[hsl(var(--chart-1))]/70"
    );
    expect(screen.queryByText(/Wallet is empty/i)).not.toBeInTheDocument();
    expect(
      screen.getByText("P/L temporarily unavailable.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/Total is withheld/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/observer read model/i)).not.toBeInTheDocument();
  });

  it("reuses the legacy balance bar for a complete wallet breakdown", () => {
    state.overview = {
      configured: true,
      connected: true,
      freshness: "read_model",
      address: "0x1111111111111111111111111111111111111111",
      interval: "1W",
      capturedAt: "2026-10-02T12:00:00.000Z",
      pol_gas: 1,
      usdc_available: 3.78,
      usdc_locked: 2,
      usdc_positions_mtm: 45.49,
      usdc_total: 51.27,
      open_orders: 1,
      positions_synced_at: "2026-10-02T12:00:00.000Z",
      positions_sync_age_ms: 0,
      positions_stale: false,
      pnlHistory: [],
      warnings: [],
    };

    render(<TradingWalletCard />);

    expect(screen.getByText("balance bar")).toBeInTheDocument();
    expect(screen.getByText("1 open order")).toBeInTheDocument();
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

  it("shows deployment readiness truth instead of exposing an unusable wallet", () => {
    state.overview = {
      configured: false,
      connected: true,
      freshness: "read_model",
      address: "0x1111111111111111111111111111111111111111",
      interval: "1W",
      capturedAt: "2026-10-02T12:00:00.000Z",
      pol_gas: 1,
      usdc_available: 10,
      usdc_locked: 0,
      usdc_positions_mtm: 2,
      usdc_total: 12,
      open_orders: 0,
      positions_synced_at: "2026-10-02T12:00:00.000Z",
      positions_sync_age_ms: 0,
      positions_stale: false,
      pnlHistory: [],
      warnings: [
        { code: "wallet_adapter_unconfigured", message: "unconfigured" },
      ],
    };

    render(<TradingWalletCard />);
    expect(
      screen.getByText("Trading-wallet adapter is not configured on this pod yet.")
    ).toBeInTheDocument();
    expect(screen.queryByText("balance bar")).not.toBeInTheDocument();
  });

  it("hides execution rows and freshness copy when the adapter is unconfigured", () => {
    state.overview = {
      configured: false,
      connected: true,
      warnings: [
        { code: "wallet_adapter_unconfigured", message: "unconfigured" },
      ],
    };
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [{ positionId: "historical-position" }],
      live_position_count: 1,
      market_groups: [],
      closed_positions: [],
      closed_position_count: 0,
      warnings: [],
    };
    state.actionsAllowed = false;

    render(<ExecutionActivityCard />);
    expect(
      screen.getByText("Trading-wallet execution is unavailable on this deployment.")
    ).toBeInTheDocument();
    expect(screen.queryByText("position rows")).not.toBeInTheDocument();
    expect(screen.queryByText(/actions are paused/i)).not.toBeInTheDocument();
    state.actionsAllowed = true;
    state.overview = undefined;
  });

  it("keeps stale P/L concise without rendering a false empty chart", () => {
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

    expect(screen.getByText("P/L temporarily unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/saved observation/i)).not.toBeInTheDocument();
    // Use the real WalletProfitLossCard here: stale availability must prevent
    // its empty-series fallback from contradicting the explicit stale state.
    expect(screen.queryByText("No P/L history yet.")).not.toBeInTheDocument();
  });

  it("keeps a P/L read failure concise without claiming observer absence", () => {
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

    expect(screen.getByText("P/L temporarily unavailable.")).toBeInTheDocument();
    expect(screen.queryByText(/saved read/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/observer/i)).not.toBeInTheDocument();
    expect(screen.queryByText("No P/L history yet.")).not.toBeInTheDocument();
  });

  it("renders never-observed live positions as unavailable, not Live(0) or empty", () => {
      state.execution = {
        address: "0x1111111111111111111111111111111111111111",
        freshness: "live",
        capturedAt: "2026-10-02T12:00:00.000Z",
        dailyTradeCounts: [],
        live_positions: [],
        market_groups: [],
        closed_positions: [],
        warnings: [{ code: "current_positions_never_observed", message: "position model unavailable" }],
      };

      render(<ExecutionActivityCard />);

      expect(
        screen.getByRole("button", { name: /Live.*—/i })
      ).toBeInTheDocument();
      expect(
        screen.getByText("Open positions unavailable.")
      ).toBeInTheDocument();
      expect(screen.queryByText("No open positions.")).not.toBeInTheDocument();
      expect(screen.queryByText(/not a zero-position/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/position model/i)).not.toBeInTheDocument();
  });

  it("retains stale exact count while suppressing position actions", () => {
    state.actionsAllowed = false;
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [{ positionId: "stale-position" }],
      live_position_count: 3,
      market_groups: [],
      closed_positions: [],
      closed_position_count: 0,
      warnings: [{ code: "current_positions_stale", message: "stale" }],
    };

    render(<ExecutionActivityCard />);

    expect(screen.getByRole("button", { name: /Live.*3/i })).toBeInTheDocument();
    expect(screen.getByText(/actions are paused/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "position action" })).not.toBeInTheDocument();
    expect(screen.queryByText("Open positions unavailable.")).not.toBeInTheDocument();
    state.actionsAllowed = true;
  });

  it("keeps the position histogram without rendering preview disclaimers", () => {
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

    expect(
      screen.getByRole("button", { name: /Live.*501/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("position distribution")).toBeInTheDocument();
    expect(screen.queryByText(/bounded preview/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/upstream data is temporarily unavailable/i),
    ).not.toBeInTheDocument();
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
        { code: "history_unavailable", message: "read failed" },
      ],
    };

    render(<ExecutionActivityCard />);
    fireEvent.click(screen.getByRole("button", { name: /Closed/i }));

    expect(screen.getByRole("button", { name: /Closed.*—/i })).toBeInTheDocument();
    expect(screen.queryByText(/not a zero-history/i)).not.toBeInTheDocument();
    expect(
      screen.getByText("Closed position history unavailable.")
    ).toBeInTheDocument();
    expect(screen.queryByText("No closed positions yet.")).not.toBeInTheDocument();
  });

  it("reuses the shared time window in both closed execution views", () => {
    state.setInterval.mockClear();
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      live_position_count: 0,
      market_groups: [],
      closed_positions: [],
      closed_position_count: 0,
      warnings: [],
    };

    render(<ExecutionActivityCard />);

    expect(screen.queryByTestId("time-window")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Closed.*0/i }));
    expect(screen.getByTestId("time-window")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1D" }));
    expect(state.setInterval).toHaveBeenCalledWith("1D");

    fireEvent.click(screen.getByRole("button", { name: "Markets" }));
    expect(screen.queryByTestId("time-window")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Closed markets" }));
    expect(screen.getByTestId("time-window")).toBeInTheDocument();
  });

  it("keeps the market histogram mounted when exposure is unavailable", () => {
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

    expect(
      screen.getByText("Market exposure temporarily unavailable.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/not a zero-exposure/i)).not.toBeInTheDocument();
    expect(screen.getByText("market distribution")).toBeInTheDocument();
    expect(screen.queryByText("markets table")).not.toBeInTheDocument();
  });

  it("keeps the market histogram without rendering preview disclaimers", () => {
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      live_position_count: 0,
      market_groups: [],
      closed_positions: [],
      closed_position_count: 0,
      warnings: [
        { code: "market_exposure_preview_truncated", message: "bounded" },
      ],
    };

    render(<ExecutionActivityCard />);
    fireEvent.click(screen.getByRole("button", { name: "Markets" }));

    expect(screen.getByText("market distribution")).toBeInTheDocument();
    expect(
      screen.queryByText("Showing a bounded market-comparison preview.")
    ).not.toBeInTheDocument();
  });

  it("ignores partial coverage metadata and renders the saved market deltas", () => {
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      dailyTradeCounts: [],
      live_positions: [],
      live_position_count: 0,
      market_groups: [
        { groupKey: "market-1", status: "live", edgeGapPct: 0.1, lines: [] },
      ],
      closed_positions: [],
      closed_position_count: 0,
      comparisonCoverage: {
        markets: {
          live: {
            eligible: 1,
            comparable: 1,
            dropped: 0,
            sampled: 0,
            complete: false,
            reasons: ["source_incomplete", "preview_truncated"],
          },
        },
      },
      warnings: [
        { code: "market_exposure_preview_truncated", message: "bounded" },
      ],
    };

    render(<ExecutionActivityCard />);
    fireEvent.click(screen.getByRole("button", { name: "Markets" }));

    expect(screen.getByText("market distribution")).toBeInTheDocument();
    expect(
      screen.queryByText(/Compared 1 of 1 markets/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Chart sample/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Partial comparison/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/histogram is withheld/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/stale or incomplete/i)).not.toBeInTheDocument();
  });

  it("shows the wallet partial badge for malformed order amounts", () => {
    state.overview = {
      configured: true,
      connected: true,
      freshness: "read_model",
      address: "0x1111111111111111111111111111111111111111",
      interval: "1W",
      capturedAt: "2026-10-02T12:00:00.000Z",
      pol_gas: 1,
      usdc_available: null,
      usdc_locked: null,
      usdc_positions_mtm: 2,
      usdc_total: null,
      open_orders: 1,
      positions_synced_at: "2026-10-02T12:00:00.000Z",
      positions_sync_age_ms: 0,
      positions_stale: false,
      pnlHistory: [],
      warnings: [
        { code: "orders_malformed_numeric", message: "malformed" },
      ],
    };

    render(<TradingWalletCard />);
    expect(screen.getByText("partial")).toBeInTheDocument();
    expect(screen.getByText("1 open order")).toBeInTheDocument();
  });

  it.each([
    ["wallet_adapter_unconfigured", /history is unavailable on this deployment/i],
    ["no_trading_wallet", /Connect a trading wallet from Money/i],
    [
      "daily_trade_counts_unavailable",
      /Trade history is temporarily unavailable/i,
    ],
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
    expect(screen.queryByText(/not a zero-trade/i)).not.toBeInTheDocument();
  });

  it("renders the interval-scoped activity unit and buckets", () => {
    state.execution = {
      address: "0x1111111111111111111111111111111111111111",
      freshness: "read_model",
      capturedAt: "2026-10-02T12:00:00.000Z",
      tradeActivity: {
        bucketUnit: "hour",
        buckets: [
          { start: "2026-10-02T10:00:00.000Z", n: 2 },
          { start: "2026-10-02T11:00:00.000Z", n: 3 },
        ],
      },
      live_positions: [],
      market_groups: [],
      closed_positions: [],
      warnings: [],
    };

    render(<OperatorWalletChartsRow />);

    expect(screen.getByTestId("trade-volume")).toHaveAttribute(
      "data-bucket-unit",
      "hour"
    );
    expect(screen.getByTestId("trade-volume")).toHaveTextContent(
      "2026-10-02T10:00:00.000Z:2|2026-10-02T11:00:00.000Z:3"
    );
  });
});
