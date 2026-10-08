// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

"use client";

import type { ReactElement } from "react";
import { Card, CardContent } from "@/components";
import { TradesPerDayChart } from "@/features/wallet-analysis";
import { useWalletDashboard } from "../_hooks/useWalletDashboard";

export function OperatorWalletChartsRow(): ReactElement {
  const dashboard = useWalletDashboard();
  const data = dashboard.data?.execution;
  const { isLoading, isError } = dashboard;

  const tradeActivity = data?.tradeActivity;
  const activityBuckets = (tradeActivity?.buckets ?? []).map((point) => ({
    d: point.start,
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
            Trade history is temporarily unavailable.
          </div>
        ) : !isLoading && activityBuckets.length === 0 ? (
          <div className="flex h-44 items-center justify-center text-center text-muted-foreground text-sm">
            No trade history yet.
          </div>
        ) : (
          <TradesPerDayChart
            daily={activityBuckets}
            bucketUnit={tradeActivity?.bucketUnit}
            isLoading={isLoading}
          />
        )}
      </CardContent>
    </Card>
  );
}
