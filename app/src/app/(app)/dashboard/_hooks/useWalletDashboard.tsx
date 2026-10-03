// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

"use client";

import type {
  PolyWalletDashboardOutput,
  PolyWalletOverviewInterval,
} from "@cogni/poly-node-contracts";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { fetchWalletDashboard } from "../_api/fetchWalletDashboard";

export const WALLET_DASHBOARD_QUERY_KEY = "dashboard-wallet-snapshot";

export function invalidateWalletDashboardSnapshot(
  queryClient: Pick<QueryClient, "invalidateQueries">
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: [WALLET_DASHBOARD_QUERY_KEY],
  });
}

type WalletDashboardContextValue = {
  data: PolyWalletDashboardOutput | undefined;
  isLoading: boolean;
  isError: boolean;
  interval: PolyWalletOverviewInterval;
  setInterval: (interval: PolyWalletOverviewInterval) => void;
};

const WalletDashboardContext = createContext<WalletDashboardContextValue | null>(
  null
);

export function WalletDashboardProvider({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  const [interval, setInterval] = useState<PolyWalletOverviewInterval>("1W");
  const query = useQuery({
    queryKey: [WALLET_DASHBOARD_QUERY_KEY, interval],
    queryFn: () => fetchWalletDashboard(interval),
    refetchInterval: 30_000,
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });
  const value = useMemo<WalletDashboardContextValue>(
    () => ({
      data: query.data,
      isLoading: query.isLoading,
      isError: query.isError,
      interval,
      setInterval,
    }),
    [query.data, query.isLoading, query.isError, interval]
  );
  return (
    <WalletDashboardContext.Provider value={value}>
      {children}
    </WalletDashboardContext.Provider>
  );
}

export function useWalletDashboard(): WalletDashboardContextValue {
  const value = useContext(WalletDashboardContext);
  if (value === null) {
    throw new Error("useWalletDashboard must be used within WalletDashboardProvider");
  }
  return value;
}
