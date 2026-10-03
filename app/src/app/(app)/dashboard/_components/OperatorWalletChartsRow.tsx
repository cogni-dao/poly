// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import type { ReactElement } from "react";
import { Card, CardContent } from "@/components";
import { TradesPerDayChart } from "@/features/wallet-analysis";
import { useDashboardExecution } from "../_hooks/useDashboardExecution";

export function OperatorWalletChartsRow(): ReactElement {
  const { data, isLoading, isError } = useDashboardExecution();

  const dailyCounts = (data?.dailyTradeCounts ?? []).map((point) => ({
    d: point.day.slice(5),
    n: point.n,
  }));
  const dailyCountsUnavailable = data?.warnings.some(
    (warning) => warning.code === "daily_trade_counts_unavailable"
  );
  const walletAdapterUnavailable = data?.warnings.some(
    (warning) => warning.code === "wallet_adapter_unconfigured"
  );
  const tradingWalletMissing = data?.warnings.some(
    (warning) => warning.code === "no_trading_wallet"
  );

  return (
    <Card>
      <CardContent className="px-5 py-4">
        {isError ? (
          <div className="flex h-44 items-center justify-center text-center text-muted-foreground text-sm">
            Couldn&apos;t load trade volume. Will retry shortly.
          </div>
        ) : walletAdapterUnavailable ? (
          <div
            className="flex h-44 items-center justify-center text-center text-muted-foreground text-sm"
            role="status"
          >
            Trading-wallet history is unavailable on this deployment.
          </div>
        ) : tradingWalletMissing ? (
          <div
            className="flex h-44 items-center justify-center text-center text-muted-foreground text-sm"
            role="status"
          >
            Connect a trading wallet from Money to see trade history.
          </div>
        ) : dailyCountsUnavailable ? (
          <div
            className="flex h-44 items-center justify-center text-center text-muted-foreground text-sm"
            role="status"
          >
            Trade history is temporarily unavailable. This is not a zero-trade result.
          </div>
        ) : !isLoading && dailyCounts.length === 0 ? (
          <div className="flex h-44 items-center justify-center text-center text-muted-foreground text-sm">
            No trade history yet.
          </div>
        ) : (
          <TradesPerDayChart daily={dailyCounts} isLoading={isLoading} />
        )}
      </CardContent>
    </Card>
  );
}
