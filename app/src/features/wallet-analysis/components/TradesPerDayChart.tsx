// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/wallet-analysis/components/TradesPerDayChart`
 * Purpose: Reusable trade-activity bar chart with hour/day/month/year buckets.
 * Scope: Presentational only. Uses CSS for bars; no chart library.
 * Invariants: Bars are normalized to the max count in the dataset; the latest bucket is rendered in primary color.
 * Side-effects: none
 * @public
 */

"use client";

import type { WalletExecutionTradeBucketUnit } from "@cogni/poly-node-contracts";
import type { ReactElement } from "react";

import { cn } from "@/shared/util/cn";
import type { WalletDailyCount } from "../types/wallet-analysis";

export type TradesPerDayChartProps = {
  daily?: readonly WalletDailyCount[] | undefined;
  bucketUnit?: WalletExecutionTradeBucketUnit | undefined;
  isLoading?: boolean | undefined;
};

export function TradesPerDayChart({
  daily,
  bucketUnit = "day",
  isLoading,
}: TradesPerDayChartProps): ReactElement {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <h4 className="font-semibold text-sm uppercase tracking-widest">
          Trades / {bucketUnit}
        </h4>
        <div className="h-28 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  if (!daily || daily.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <h4 className="font-semibold text-sm uppercase tracking-widest">
          Trades / {bucketUnit}
        </h4>
        <div className="flex h-28 items-center justify-center text-muted-foreground text-sm">
          No trade history yet.
        </div>
      </div>
    );
  }

  const rawMax = daily.reduce((m, d) => Math.max(m, d.n), 0);
  /** Bar scale floor only — must not be shown as a "user cap" when all days are 0. */
  const scaleMax = Math.max(rawMax, 1);
  const total = daily.reduce((s, d) => s + d.n, 0);
  const latest = daily.at(-1);
  const summarySuffix =
    rawMax > 0 ? ` · peak ${rawMax}/${bucketUnit}` : "";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h4 className="font-semibold text-sm uppercase tracking-widest">
          Trades / {bucketUnit}
        </h4>
        <span className="font-mono text-muted-foreground text-xs">
          {total} total{summarySuffix}
        </span>
      </div>
      <div className="flex h-32 items-end gap-1">
        {daily.map((d, i) => {
          // pixel heights — h-32 is 8rem ≈ 128px. Reserve ~14px at the top
          // for an inline count label so it never clips the upper edge.
          const CHART_PX = 112;
          const heightPx =
            d.n === 0
              ? 4
              : Math.max(8, Math.round((d.n / scaleMax) * CHART_PX));
          const isLatest = i === daily.length - 1;
          const showTick = shouldShowTick(i, daily.length);
          return (
            <div
              key={d.d}
              className="group relative flex flex-1 flex-col items-center justify-end gap-1"
              title={`${formatBucketLabel(d.d, bucketUnit, "long")} · ${d.n} trade${
                d.n === 1 ? "" : "s"
              }`}
            >
              {/* Always-visible count label above each non-zero bar; reserves
                  a blank row above zero bars so bars stay aligned. */}
              <span
                className={cn(
                  "font-mono text-xs tabular-nums leading-none",
                  d.n === 0 || (daily.length > 14 && !showTick)
                    ? "invisible"
                    : isLatest
                      ? "text-primary"
                      : "text-muted-foreground"
                )}
              >
                {d.n}
              </span>
              <div
                style={{ height: `${heightPx}px` }}
                className={cn(
                  "w-full rounded-t-sm transition-colors",
                  isLatest
                    ? "bg-primary"
                    : "bg-muted-foreground/40 group-hover:bg-primary/60"
                )}
              />
              <span
                className={cn(
                  "font-mono text-muted-foreground text-xs leading-none",
                  showTick ? "visible" : "invisible"
                )}
              >
                {formatBucketLabel(d.d, bucketUnit, "short")}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex items-baseline justify-between text-muted-foreground text-xs">
        <span>
          {formatBucketLabel(daily[0]?.d ?? "", bucketUnit, "long")}
        </span>
        <span className="font-mono">
          {formatBucketLabel(latest?.d ?? "", bucketUnit, "long")} ·{" "}
          <span className="text-primary">{latest?.n ?? 0} trades</span>
        </span>
      </div>
    </div>
  );
}

function shouldShowTick(index: number, length: number): boolean {
  if (length <= 12) return true;
  const cadence = Math.ceil(length / 6);
  return index === 0 || index === length - 1 || index % cadence === 0;
}

function formatBucketLabel(
  value: string,
  unit: WalletExecutionTradeBucketUnit,
  width: "short" | "long"
): string {
  if (/^\d{2}-\d{2}$/.test(value)) {
    return unit === "day" && width === "short" ? value.slice(-2) : value;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return unit === "day" && width === "short" ? value.slice(-2) : value;
  }
  switch (unit) {
    case "hour":
      return width === "long"
        ? parsed.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })
        : parsed.toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          });
    case "day":
      return width === "short"
        ? parsed.toLocaleDateString("en-US", { day: "numeric" })
        : parsed.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });
    case "month":
      return width === "long"
        ? parsed.toLocaleDateString("en-US", {
            month: "short",
            year: "numeric",
          })
        : parsed.toLocaleDateString("en-US", { month: "short" });
    case "year":
      return parsed.getUTCFullYear().toString();
  }
}
