// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_components/MirrorAttemptsCard`
 * Purpose: Surface the copy-trade order ledger — every mirror placement attempt and,
 *          for the failures, the upstream reason. Answers "the mirror is active, so
 *          why has nothing landed?" without a Loki query.
 * Scope: Client component. Read-only. Sources `/api/v1/poly/copy-trade/orders`.
 * Invariants:
 *   - FAILURES_ARE_THE_POINT (bug.5279) — a successful-fills-only view is useless
 *     during an outage, which is exactly when someone looks. Error rows render their
 *     `error` text, which carries the CLOB's own words since bug.5267 (e.g.
 *     `clob_error="Trading restricted in your region"`). Never filter errors out.
 *   - TENANT_SCOPED upstream: the route clamps to the caller's billing account.
 * Side-effects: IO (React Query).
 * Links: [fetchCopyTradeOrders](../_api/fetchCopyTradeOrders.ts),
 *        app/src/app/api/v1/poly/copy-trade/orders/route.ts
 * @public
 */

"use client";

import type { PolyCopyTradeOrderRow } from "@cogni/poly-node-contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactElement } from "react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";
import { cn } from "@/shared/util/cn";
import { fetchCopyTradeOrders } from "../_api/fetchCopyTradeOrders";

const REFETCH_MS = 30_000;
const ROW_LIMIT = 25;

/** Compress the adapter's message to the operative clause. */
export function summarizeLedgerError(error: string | null): string | null {
  if (!error) return null;
  const clob = /clob_error="([^"]+)"/.exec(error);
  if (clob?.[1]) return clob[1];
  const reason = /reason="([^"]+)"/.exec(error);
  if (reason?.[1]) return reason[1];
  return error.length > 160 ? `${error.slice(0, 160)}…` : error;
}

function statusTone(status: PolyCopyTradeOrderRow["status"]): string {
  if (status === "filled") return "text-emerald-600 dark:text-emerald-400";
  if (status === "error" || status === "canceled")
    return "text-destructive font-medium";
  return "text-muted-foreground";
}

function fmtUsdc(v: number | null): string {
  return v === null ? "--" : `$${v.toFixed(2)}`;
}

export function MirrorAttemptsCard(): ReactElement {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["poly-copy-trade-orders", ROW_LIMIT],
    queryFn: () => fetchCopyTradeOrders({ limit: ROW_LIMIT }),
    refetchInterval: REFETCH_MS,
  });

  const rows = data?.orders ?? [];
  const failures = rows.filter((r) => r.status === "error").length;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between px-5 py-3">
        <CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          Mirror attempts
        </CardTitle>
        {failures > 0 ? (
          <span className="text-destructive text-xs">
            {failures} of {rows.length} rejected
          </span>
        ) : null}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="animate-pulse space-y-px px-5 pb-4">
            <div className="h-10 rounded bg-muted" />
            <div className="h-10 rounded bg-muted" />
          </div>
        ) : isError ? (
          <p className="px-5 pb-4 text-muted-foreground text-sm">
            Could not load mirror attempts.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-5 pb-4 text-muted-foreground text-sm">
            No placement attempts yet. A tracked wallet must trade, and the fill
            must clear your sizing floors, before an order is attempted.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.client_order_id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {new Date(r.observed_at).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="max-w-[18rem] truncate text-sm">
                    {r.market_title ?? r.outcome ?? "--"}
                  </TableCell>
                  <TableCell className="text-sm">{r.side ?? "--"}</TableCell>
                  <TableCell className="text-right text-sm">
                    {fmtUsdc(r.size_usdc)}
                  </TableCell>
                  <TableCell className={cn("text-sm", statusTone(r.status))}>
                    {r.status}
                  </TableCell>
                  <TableCell className="max-w-[22rem] text-muted-foreground text-xs">
                    {summarizeLedgerError(r.error) ?? ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
