// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_hooks/useDashboardExecution`
 * Purpose: Dashboard execution query. Single fetch per tick — the execution
 * route does identical work for every freshness value, so a second
 * "read model first" request would double server load for no extra data
 * (task.5009).
 * Scope: Client-side React Query composition only. No route logic.
 * Side-effects: IO (HTTP fetch via React Query).
 * Links: docs/spec/poly-copy-trade-execution.md
 * @internal
 */

"use client";

import type { PolyWalletExecutionOutput } from "@cogni/poly-node-contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { fetchExecution } from "../_api/fetchExecution";

const EXECUTION_REFETCH_MS = 30_000;

export function useDashboardExecution(opts?: {
  onLiveData?: (data: PolyWalletExecutionOutput) => void;
}): {
  data: PolyWalletExecutionOutput | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const onLiveData = opts?.onLiveData;

  const query = useQuery({
    queryKey: ["dashboard-wallet-execution"],
    queryFn: () => fetchExecution({ freshness: "live" }),
    refetchInterval: EXECUTION_REFETCH_MS,
    staleTime: 10_000,
    gcTime: 60_000,
    retry: 1,
  });

  useEffect(() => {
    if (query.data) onLiveData?.(query.data);
  }, [query.data, onLiveData]);

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
