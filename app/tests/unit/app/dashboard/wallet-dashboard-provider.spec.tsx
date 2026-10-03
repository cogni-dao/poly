// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** One query/key/snapshot feeds every wallet-dashboard consumer. */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { useQuery } = vi.hoisted(() => ({
  useQuery: vi.fn((_options: unknown) => ({
    data: {
      snapshotId: "11111111-1111-4111-8111-111111111111",
      capturedAt: "2026-10-03T12:00:00.000Z",
    },
    isLoading: false,
    isError: false,
  })),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/app/(app)/dashboard/_api/fetchWalletDashboard", () => ({
  fetchWalletDashboard: vi.fn(),
}));

import {
  invalidateWalletDashboardSnapshot,
  useWalletDashboard,
  WalletDashboardProvider,
  WALLET_DASHBOARD_QUERY_KEY,
} from "@/app/(app)/dashboard/_hooks/useWalletDashboard";

function Consumer({ name }: { name: string }) {
  const dashboard = useWalletDashboard();
  return (
    <span>{`${name}:${dashboard.data?.snapshotId}:${dashboard.data?.capturedAt}`}</span>
  );
}

describe("WalletDashboardProvider", () => {
  it("runs one query and shares one snapshot identity across all three cards", () => {
    render(
      <WalletDashboardProvider>
        <Consumer name="wallet" />
        <Consumer name="charts" />
        <Consumer name="execution" />
      </WalletDashboardProvider>
    );
    expect(useQuery).toHaveBeenCalledOnce();
    expect(useQuery.mock.calls[0]?.[0]).toMatchObject({
      queryKey: [WALLET_DASHBOARD_QUERY_KEY, "1W"],
      refetchInterval: 30_000,
      staleTime: 15_000,
    });
    for (const name of ["wallet", "charts", "execution"]) {
      expect(screen.getByText(`${name}:11111111-1111-4111-8111-111111111111:2026-10-03T12:00:00.000Z`)).toBeInTheDocument();
    }
  });

  it("uses the same unified prefix for manual refresh and position actions", async () => {
    const invalidateQueries = vi.fn(async () => undefined);
    await invalidateWalletDashboardSnapshot({ invalidateQueries } as never);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [WALLET_DASHBOARD_QUERY_KEY],
    });
  });
});
