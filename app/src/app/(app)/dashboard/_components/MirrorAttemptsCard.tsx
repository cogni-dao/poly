// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_components/MirrorAttemptsCard`
 * Purpose: Surface the canonical decision-backed attempt tape for every algorithm.
 * Scope: Client component. Read-only. Sources `/api/v1/poly/copy-trade/attempts`.
 * Invariants:
 *   - FAILURES_ARE_THE_POINT (bug.5279) — a successful-fills-only view is useless
 *     during an outage, which is exactly when someone looks. Error rows render their
 *     `error` text, which carries the CLOB's own words since bug.5267 (e.g.
 *     `clob_error="Trading restricted in your region"`); canceled rows render the
 *     bounded internal cancellation code carried by the same frozen field. Never
 *     filter failures out.
 *   - TENANT_SCOPED upstream: the route clamps to the caller's billing account.
 * Side-effects: IO (React Query).
 * Links: [fetchCopyTradeAttempts](../_api/fetchCopyTradeAttempts.ts),
 *        app/src/app/api/v1/poly/copy-trade/attempts/route.ts
 * @public
 */

"use client";

import type {
  PolyCopyTradeAttempt,
  PolyCopyTradeOrderRow,
} from "@cogni/poly-node-contracts";
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
import { fetchCopyTradeAttempts } from "../_api/fetchCopyTradeAttempts";

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

/** Prefer a human title and never present a binary outcome index as a market. */
export function marketLabel(row: PolyCopyTradeOrderRow): string {
  const title = row.market_title?.trim();
  if (title && title !== "0" && title !== "1") return title;
  const conditionId = row.market_id?.replace(
    /^prediction-market:polymarket:/,
    "",
  );
  return conditionId ? `Market ${conditionId.slice(0, 10)}…` : "--";
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

function attemptMarketLabel(row: PolyCopyTradeAttempt): string {
  const title = row.market_title?.trim();
  if (title && title !== "0" && title !== "1") return title;
  const conditionId = row.market_id?.replace(
    /^prediction-market:polymarket:/,
    ""
  );
  return conditionId ? `Market ${conditionId.slice(0, 10)}…` : "--";
}

function algorithmLabel(row: PolyCopyTradeAttempt): string {
  if (row.algorithm.availability === "unavailable") return "Legacy";
  const family = row.algorithm.algorithm_id.replace("poly.copy-mirror.", "");
  return `${family} · ${row.algorithm.algorithm_version_id.slice(-8)}`;
}

function executionLabel(row: PolyCopyTradeAttempt): string {
  if (row.executed.availability === "observed") {
    return row.executed.terminal_reason
      ? `${row.executed.status} · ${summarizeLedgerError(
          row.executed.terminal_reason
        )}`
      : row.executed.status;
  }
  if (row.executed.availability === "ledger_row_missing") {
    return "inconsistent · ledger missing";
  }
  return "no order";
}

export function MirrorAttemptsCard(): ReactElement {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["poly-copy-trade-attempts", ROW_LIMIT],
    queryFn: () => fetchCopyTradeAttempts({ limit: ROW_LIMIT }),
    refetchInterval: REFETCH_MS,
  });

  const rows = data?.attempts ?? [];
  const failures = rows.filter(
    (r) =>
      r.decision.outcome === "error" ||
      r.executed.availability === "ledger_row_missing" ||
      (r.executed.availability === "observed" &&
        r.executed.status === "error")
  ).length;

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
            No algorithm decisions yet. A tracked wallet or reconciliation must
            produce eligible facts before an attempt appears.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Algorithm</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Intended</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Execution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.attempt_id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {new Date(r.decided_at).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="max-w-[18rem] truncate text-sm">
                    {attemptMarketLabel(r)}
                  </TableCell>
                  <TableCell className="max-w-[16rem] truncate text-xs">
                    {algorithmLabel(r)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {r.intended.side ?? "--"}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {fmtUsdc(r.intended.size_usdc)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-sm",
                      r.decision.outcome === "placed"
                        ? statusTone("filled")
                        : r.decision.outcome === "error"
                          ? statusTone("error")
                          : "text-muted-foreground"
                    )}
                  >
                    {r.decision.outcome}
                    {r.decision.reason ? ` · ${r.decision.reason}` : ""}
                  </TableCell>
                  <TableCell className="max-w-[22rem] text-muted-foreground text-xs">
                    {executionLabel(r)}
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
