// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/research/w/[addr]/view`
 * Purpose: Read-only wallet research page over the restored Poly runtime APIs.
 * Scope: Client view for wallet snapshot/trades placeholders.
 * Invariants: READ_ONLY_BOOTSTRAP, NO_TRADING_SIDE_EFFECTS.
 * Side-effects: Authenticated HTTP reads through React Query.
 * @public
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, BarChart3, History, Wallet } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components";

type WarningDto = {
  code: string;
  message: string;
};

type WalletProfileResponse = {
  address: string;
  include: string | null;
  snapshot: unknown | null;
  positions: unknown[];
  trades: unknown[];
  capturedAt?: string;
  warnings?: WarningDto[];
};

async function fetchWalletProfile(
  address: string
): Promise<WalletProfileResponse> {
  const params = new URLSearchParams({ include: "snapshot" });
  const res = await fetch(
    `/api/v1/poly/wallets/${address}?${params.toString()}`,
    { credentials: "include" }
  );
  if (!res.ok) {
    throw new Error(`wallet profile failed with ${res.status}`);
  }
  return (await res.json()) as WalletProfileResponse;
}

function compactAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function WalletResearchView({
  address,
}: {
  address: string;
}): ReactElement {
  const profile = useQuery({
    queryKey: ["poly-wallet-research", address],
    queryFn: () => fetchWalletProfile(address),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const warnings = profile.data?.warnings ?? [];

  return (
    <div className="flex flex-col gap-6 p-5 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <Button asChild variant="ghost" size="sm" className="w-fit">
            <Link href="/research">
              <ArrowLeft className="size-4" />
              Research
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <Wallet className="size-5 text-primary" />
            <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
              {compactAddress(address)}
            </h1>
          </div>
          <p className="break-all font-mono text-muted-foreground text-sm">
            {address}
          </p>
        </div>
        <Badge intent="secondary" className="w-fit">
          Read-only
        </Badge>
      </div>

      {warnings.length > 0 ? (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          {warnings.map((warning) => (
            <p key={warning.code}>{warning.message}</p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <BarChart3 className="size-4 text-primary" />
              Snapshot
            </CardTitle>
            <CardDescription>Wallet read model</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl">
              {profile.data?.snapshot ? "Available" : "Pending"}
            </div>
            <p className="text-muted-foreground text-xs">
              Captured {profile.data?.capturedAt ?? "after restore"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Wallet className="size-4 text-primary" />
              Positions
            </CardTitle>
            <CardDescription>Current market exposure</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl">
              {profile.data?.positions.length ?? 0}
            </div>
            <p className="text-muted-foreground text-xs">Open positions</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="size-4 text-primary" />
              Trades
            </CardTitle>
            <CardDescription>Recent observed fills</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl">
              {profile.data?.trades.length ?? 0}
            </div>
            <p className="text-muted-foreground text-xs">Loaded fills</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent trades</CardTitle>
          <CardDescription>
            DB-backed fills will appear here as the wallet read models are
            restored.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Market</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-28 text-center text-muted-foreground"
                >
                  {profile.isLoading
                    ? "Loading wallet profile..."
                    : "No wallet trades are loaded yet."}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
