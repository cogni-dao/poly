// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/research/view`
 * Purpose: First restored Poly research surface backed by read-only runtime APIs.
 * Scope: Client view for research status, wallet search, top-wallet rows, and
 *   target/wallet state. Does not place orders or mutate copy-trade targets.
 * Invariants: READ_ONLY_BOOTSTRAP, NO_TRADING_SIDE_EFFECTS.
 * Side-effects: Authenticated HTTP reads through React Query.
 * @public
 */

"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Radio,
  Search,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactElement } from "react";

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
} from "@/components";
import { cn } from "@/lib/cn";

const PERIOD_OPTIONS = ["DAY", "WEEK", "MONTH", "ALL"] as const;
type WalletTimePeriod = (typeof PERIOD_OPTIONS)[number];

type WarningDto = {
  code: string;
  message: string;
};

type TopWallet = {
  proxyWallet?: string;
  address?: string;
  wallet?: string;
  pseudonym?: string;
  rank?: number;
  pnl?: number;
  volume?: number;
  winRate?: number;
  trades?: number;
};

type TopWalletsResponse = {
  wallets?: TopWallet[];
  traders?: TopWallet[];
  limit?: number;
  capturedAt?: string;
  warnings?: WarningDto[];
};

type WalletStatusResponse = {
  configured?: boolean;
  connected?: boolean;
  address?: string | null;
  warnings?: WarningDto[];
};

type CopyTargetsResponse = {
  targets?: Array<{
    target_id?: string;
    target_wallet?: string;
    disabled_at?: string | null;
  }>;
};

type SyncHealthResponse = {
  oldest_synced_row_age_ms: number | null;
  rows_stale_over_60s: number;
  rows_never_synced: number;
  reconciler_last_tick_at: string | null;
};

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "include" });
  if (!res.ok) {
    throw new Error(`${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

function walletAddress(row: TopWallet): string | null {
  return row.proxyWallet ?? row.address ?? row.wallet ?? null;
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCurrency(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function compactAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function WarningStrip({ warnings }: { warnings: WarningDto[] }): ReactElement {
  if (warnings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
        <ShieldCheck className="size-4" />
        <span>Runtime reads are online.</span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        {warnings.map((warning) => (
          <p key={warning.code}>{warning.message}</p>
        ))}
      </div>
    </div>
  );
}

export function ResearchView(): ReactElement {
  const [period, setPeriod] = useState<WalletTimePeriod>("WEEK");
  const [query, setQuery] = useState("");

  const topWallets = useQuery({
    queryKey: ["poly-research-top-wallets", period],
    queryFn: () =>
      fetchJson<TopWalletsResponse>(
        `/api/v1/poly/top-wallets?limit=100&period=${period}`
      ),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const walletStatus = useQuery({
    queryKey: ["poly-research-wallet-status"],
    queryFn: () => fetchJson<WalletStatusResponse>("/api/v1/poly/wallet/status"),
    staleTime: 15_000,
    gcTime: 60_000,
    retry: 1,
  });

  const copyTargets = useQuery({
    queryKey: ["poly-research-copy-targets"],
    queryFn: () =>
      fetchJson<CopyTargetsResponse>("/api/v1/poly/copy-trade/targets"),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const syncHealth = useQuery({
    queryKey: ["poly-research-sync-health"],
    queryFn: () =>
      fetchJson<SyncHealthResponse>("/api/v1/poly/internal/sync-health"),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
  });

  const wallets = useMemo(() => {
    const source = topWallets.data?.wallets ?? topWallets.data?.traders ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return source;
    return source.filter((row) => {
      const address = walletAddress(row)?.toLowerCase() ?? "";
      const label = row.pseudonym?.toLowerCase() ?? "";
      return address.includes(needle) || label.includes(needle);
    });
  }, [query, topWallets.data]);

  const directAddress = WALLET_RE.test(query.trim()) ? query.trim() : null;
  const warnings = [
    ...(topWallets.data?.warnings ?? []),
    ...(walletStatus.data?.warnings ?? []),
  ];
  const targetCount = copyTargets.data?.targets?.length ?? 0;
  const isBootstrapEmpty =
    !topWallets.isLoading && !topWallets.isError && wallets.length === 0;

  return (
    <div className="flex flex-col gap-6 p-5 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <BarChart3 className="size-5 text-primary" />
            <h1 className="font-semibold text-xl tracking-tight md:text-2xl">
              Research
            </h1>
          </div>
          <p className="max-w-3xl text-muted-foreground text-sm">
            Track prediction-market wallets, inspect candidate traders, and keep
            copy-trading state visible while the restored read models come back
            online.
          </p>
        </div>
        <Badge intent="secondary" className="w-fit">
          Read-only runtime
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Radio className="size-4 text-success" />
              Runtime
            </CardTitle>
            <CardDescription>Poly API health</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl">
              {syncHealth.isError ? "Auth required" : "Online"}
            </div>
            <p className="text-muted-foreground text-xs">
              Stale rows: {syncHealth.data?.rows_stale_over_60s ?? 0}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Wallet className="size-4 text-primary" />
              Wallet
            </CardTitle>
            <CardDescription>Trading wallet status</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl">
              {walletStatus.data?.connected ? "Connected" : "Not connected"}
            </div>
            <p className="text-muted-foreground text-xs">
              {walletStatus.data?.address
                ? compactAddress(walletStatus.data.address)
                : "No active wallet"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldCheck className="size-4 text-primary" />
              Targets
            </CardTitle>
            <CardDescription>Tracked copy targets</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-semibold text-2xl">{targetCount}</div>
            <p className="text-muted-foreground text-xs">
              Mutations remain disabled in this slice
            </p>
          </CardContent>
        </Card>
      </div>

      <WarningStrip warnings={warnings} />

      <Card>
        <CardHeader className="gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Wallet leaderboard</CardTitle>
              <CardDescription>
                Restored research entry point from the legacy Poly app.
              </CardDescription>
            </div>
            <ToggleGroup
              type="single"
              value={period}
              onValueChange={(value) => {
                if (PERIOD_OPTIONS.includes(value as WalletTimePeriod)) {
                  setPeriod(value as WalletTimePeriod);
                }
              }}
              className="w-fit rounded-lg border"
            >
              {PERIOD_OPTIONS.map((option) => (
                <ToggleGroupItem
                  key={option}
                  value={option}
                  className="px-3 text-xs"
                >
                  {option}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative flex-1">
              <Search className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search wallet or paste 0x address"
                className="pl-9"
              />
            </div>
            {directAddress ? (
              <Button asChild variant="secondary">
                <Link href={`/research/w/${directAddress.toLowerCase()}`}>
                  Analyze wallet
                  <ArrowRight className="size-4" />
                </Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>

        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Rank</TableHead>
                <TableHead>Wallet</TableHead>
                <TableHead className="text-right">P/L</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Trades</TableHead>
                <TableHead className="w-24 text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {topWallets.isLoading ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-28 text-center text-muted-foreground"
                  >
                    Loading wallets...
                  </TableCell>
                </TableRow>
              ) : null}
              {topWallets.isError ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-28 text-center text-muted-foreground"
                  >
                    Research data is unavailable for this session.
                  </TableCell>
                </TableRow>
              ) : null}
              {isBootstrapEmpty ? (
                <TableRow>
                  <TableCell colSpan={6} className="h-32 text-center">
                    <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-muted-foreground">
                      <BarChart3 className="size-8" />
                      <p className="font-medium text-foreground">
                        Wallet rankings are waiting on DB-backed read models.
                      </p>
                      <p className="text-sm">
                        The route and authenticated research shell are live on
                        the restored Poly runtime.
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : null}
              {wallets.map((row, index) => {
                const address = walletAddress(row);
                if (!address) return null;
                return (
                  <TableRow key={address}>
                    <TableCell className="text-muted-foreground">
                      {row.rank ?? index + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {row.pseudonym ?? compactAddress(address)}
                        </span>
                        <span className="font-mono text-muted-foreground text-xs">
                          {address}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right",
                        (row.pnl ?? 0) > 0 && "text-success",
                        (row.pnl ?? 0) < 0 && "text-destructive"
                      )}
                    >
                      {formatCurrency(row.pnl)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatCurrency(row.volume)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatNumber(row.trades)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild size="sm" variant="ghost">
                        <Link href={`/research/w/${address.toLowerCase()}`}>
                          Open
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
