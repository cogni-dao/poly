// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_hooks/useTradingWalletOverview`
 * Purpose: Trading-wallet summary query. Single `live` fetch per tick — the
 * read-model variant runs the same balances/positions work and only omits the
 * P/L history block, so pairing it with a live fetch doubled the route's
 * Polygon RPC + ledger reads for no extra data (task.5009).
 * Scope: Client-side React Query composition only. No route logic.
 * Side-effects: IO (HTTP fetch via React Query).
 * Links: docs/spec/poly-copy-trade-execution.md
 * @internal
 */

"use client";

import type {
  PolyWalletOverviewInterval,
  PolyWalletOverviewOutput,
} from "@cogni/poly-node-contracts";
import { useQuery } from "@tanstack/react-query";
import { fetchTradingWallet } from "../_api/fetchTradingWallet";

const TRADING_WALLET_OVERVIEW_REFETCH_MS = 5 * 60_000;

export function useTradingWalletOverview(
  interval: PolyWalletOverviewInterval
): {
  data: PolyWalletOverviewOutput | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: ["dashboard-trading-wallet", interval],
    queryFn: () => fetchTradingWallet(interval, { freshness: "live" }),
    refetchInterval: TRADING_WALLET_OVERVIEW_REFETCH_MS,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
