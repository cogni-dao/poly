// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Paper-account dashboard acceptance at the component boundary.
 *
 * Proves that paper onboarding does not depend on live Privy configuration,
 * never steals precedence from an existing live connection, and presents a
 * paper account as simulation rather than as a wallet-looking address.
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dashboard: undefined as unknown,
  invalidateQueries: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { connected: false, trading_ready: false } }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
  useMutation: (options: {
    mutationFn: () => Promise<void>;
    onSuccess: () => Promise<void>;
  }) => ({
    isPending: false,
    isError: false,
    mutate: () => {
      void options.mutationFn().then(options.onSuccess);
    },
  }),
}));

vi.mock("@/app/(app)/dashboard/_hooks/useWalletDashboard", () => ({
  WALLET_DASHBOARD_QUERY_KEY: "dashboard-wallet-snapshot",
  invalidateWalletDashboardSnapshot: (queryClient: {
    invalidateQueries: (input: unknown) => Promise<void>;
  }) =>
    queryClient.invalidateQueries({
      queryKey: ["dashboard-wallet-snapshot"],
    }),
  useWalletDashboard: () => ({
    data: mocks.dashboard,
    isLoading: false,
    isError: false,
    interval: "1W",
    setInterval: vi.fn(),
  }),
}));

vi.mock("@/components", () => ({
  AddressChip: ({ address }: { address: string }) => <span>{address}</span>,
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  CardContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CardHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  CardTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/features/wallet-analysis", () => ({
  TimeWindowHeader: () => <div>time window</div>,
  WalletProfitLossCard: () => <div>pnl</div>,
}));

vi.mock("@/app/(app)/dashboard/_components/TradingWalletBalanceBar", () => ({
  TradingWalletBalanceBar: () => <div>balance bar</div>,
}));

import { TradingWalletCard } from "@/app/(app)/dashboard/_components/TradingWalletCard";

const PAPER_ADDRESS = "0x1111111111111111111111111111111111111111";

function overview(overrides: Record<string, unknown> = {}) {
  return {
    configured: false,
    connected: false,
    account_kind: null,
    freshness: "read_model",
    address: null,
    interval: "1W",
    capturedAt: "2026-10-09T08:00:00.000Z",
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
    warnings: [],
    ...overrides,
  };
}

function dashboard(input: {
  overview: Record<string, unknown>;
  connectionExists: boolean;
}) {
  return {
    overview: input.overview,
    readiness: {
      connected: input.connectionExists,
      funder_address: null,
      trading_ready: false,
      auto_wrap_consent_at: null,
      auto_wrap_floor_usdce_atomic: null,
      observedAt: input.connectionExists
        ? "2026-10-09T08:00:00.000Z"
        : null,
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  mocks.invalidateQueries.mockClear();
});

describe("paper account dashboard onboarding", () => {
  it("offers honest paper terms even when the live adapter is unconfigured", () => {
    mocks.dashboard = dashboard({
      overview: overview(),
      connectionExists: false,
    });

    render(<TradingWalletCard />);

    expect(
      screen.getByRole("button", { name: "Start paper trading" })
    ).toBeInTheDocument();
    expect(screen.getByText(/\$10,000 simulated balance/i)).toBeInTheDocument();
    expect(screen.getByText(/\$20 per order and \$200 per day/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Connect live wallet →" })
    ).toHaveAttribute("href", "/credits");
    expect(
      screen.queryByText(/adapter is not configured/i)
    ).not.toBeInTheDocument();
  });

  it("posts fixed terms and invalidates both dashboard caches", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 201 }));
    vi.stubGlobal("fetch", fetch);
    mocks.dashboard = dashboard({
      overview: overview(),
      connectionExists: false,
    });

    render(<TradingWalletCard />);
    fireEvent.click(
      screen.getByRole("button", { name: "Start paper trading" })
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith("/api/v1/poly/paper-account", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        seedUsdc: 10_000,
        defaultGrant: { perOrderUsdcCap: 20, dailyUsdcCap: 200 },
      }),
    });
    await waitFor(() =>
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: ["dashboard-wallet-snapshot"],
      })
    );
    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["poly-wallet-status"],
    });
  });

  it("labels paper explicitly and hides its synthetic address", () => {
    mocks.dashboard = dashboard({
      overview: overview({
        connected: true,
        account_kind: "paper",
        address: PAPER_ADDRESS,
        usdc_available: 10_000,
        usdc_locked: 0,
        usdc_positions_mtm: 0,
        usdc_total: 10_000,
        open_orders: 0,
      }),
      connectionExists: true,
    });

    render(<TradingWalletCard />);

    expect(screen.getByText("Paper account")).toBeInTheDocument();
    expect(screen.queryByText(PAPER_ADDRESS)).not.toBeInTheDocument();
    expect(screen.getByText("balance bar")).toBeInTheDocument();
    expect(
      screen.queryByText(/adapter is not configured/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Wallet is empty/i)).not.toBeInTheDocument();
  });

  it("never creates paper over an existing incomplete live connection", () => {
    mocks.dashboard = dashboard({
      overview: overview(),
      connectionExists: true,
    });

    render(<TradingWalletCard />);

    expect(screen.getByText(/live trading wallet setup is incomplete/i)).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Finish live setup →" })
    ).toHaveAttribute("href", "/credits");
    expect(
      screen.queryByRole("button", { name: "Start paper trading" })
    ).not.toBeInTheDocument();
  });
});
