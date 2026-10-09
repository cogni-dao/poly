// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/_components/TradingWalletCard`
 * Purpose: Dashboard tile — caller's own per-tenant trading-account summary
 *   plus explicit paper/live onboarding. Paper accounts are labeled as
 *   simulation and their deterministic join address is never shown as a
 *   human wallet.
 * Scope: Client component. Uses the progressive dashboard overview hook for
 *   the balance snapshot and `/api/v1/poly/wallet/status` (shared cache key with
 *   `/credits` via `poly-wallet-status`) to drive the onboarding CTA branch.
 *   Paper creation is the one mutation; live setup remains on `/credits`.
 * Invariants:
 *   - TENANT_SCOPED: the backing route resolves the caller's own wallet from
 *     the session — no address plumbing at the UI boundary.
 *   - NO_TOMBSTONE_ROUTE: never reads the legacy `/api/v1/poly/wallet/balance`
 *     route.
 *   - NO_FAKE_HISTORY: this card renders current wallet truth only.
 *   - STATE_DRIVEN_UI (task.0361): the onboarding CTA is derived from
 *     `poly.wallet.status.v1`; no persisted onboarding-progress.
 *   - PAPER_DOES_NOT_REQUIRE_PRIVY: a tenant with no connection can create a
 *     paper account even when the live adapter is unconfigured.
 *   - LIVE_WINS_PRESENTATION: an existing live connection, including an
 *     incomplete one, never exposes the paper-create CTA. This matches
 *     execution venue precedence and prevents a hidden paper account.
 *   - PAPER_ADDRESS_IS_INTERNAL: paper renders an explicit badge, never an
 *     AddressChip containing its synthetic database join key.
 *   - FUNDED_GATES_LIVE (task.0365): when approvals are signed but the
 *     wallet holds zero USD collateral (pUSD + USDC.e both zero), the card
 *     surfaces a fund CTA in place of the balance breakdown — silent zeros
 *     let users assume "trading is on" when they actually can't place a
 *     single order. Post the 2026-04-28 cutover pUSD is the real collateral,
 *     so the empty check MUST include pUSD, not USDC.e alone.
 *   - UNKNOWN_IS_NOT_ZERO: absent/stale position or P/L read models render an
 *     explicit unavailable state. A nullable total never triggers the empty
 *     wallet CTA and cash-only is never presented as Total.
 *   - STALE_IS_LOUD (bug.5031): when positions were previously synced and are
 *     now stale/withheld, the card shows a prominent "data-sync delay, not a
 *     change in funds" banner. A stalled observer previously degraded silently
 *     to a cash-only figure with only a subtle "partial" chip, reading as a
 *     balance drop. The banner is gated to genuine stalls (non-null sync age)
 *     so a never-observed/new account never gets a false "funds changed" alarm.
 * Side-effects: IO (React Query reads; session-bound paper-account POST).
 * Links: work/items/task.0361.poly-first-user-onboarding-flow-v0.md
 * @public
 */

"use client";

import type { PolyWalletStatusOutput } from "@cogni/poly-node-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactElement } from "react";
import {
  AddressChip,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components";
import {
  TimeWindowHeader,
  WalletProfitLossCard,
} from "@/features/wallet-analysis";
import { cn } from "@/shared/util/cn";
import {
  invalidateWalletDashboardSnapshot,
  useWalletDashboard,
} from "../_hooks/useWalletDashboard";
import { TradingWalletBalanceBar } from "./TradingWalletBalanceBar";

function formatDecimal(n: number | null, fractionDigits: number): string {
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Coarse "how long ago" label for the stale-positions banner. Null when no
 * sync age is known (the banner then omits the parenthetical) so the copy
 * never invents a freshness it cannot prove.
 */
function formatSyncAge(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function fetchWalletStatus(): Promise<PolyWalletStatusOutput> {
  const response = await fetch("/api/v1/poly/wallet/status", {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`wallet status failed: ${response.status}`);
  return (await response.json()) as PolyWalletStatusOutput;
}

const PAPER_ACCOUNT_TERMS = {
  seedUsdc: 10_000,
  defaultGrant: {
    perOrderUsdcCap: 20,
    dailyUsdcCap: 200,
  },
} as const;

async function createPaperAccount(): Promise<void> {
  const response = await fetch("/api/v1/poly/paper-account", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(PAPER_ACCOUNT_TERMS),
  });
  if (!response.ok) {
    throw new Error(`paper account creation failed: ${response.status}`);
  }
}

export function TradingWalletCard(): ReactElement {
  const queryClient = useQueryClient();
  const dashboard = useWalletDashboard();
  const data = dashboard.data?.overview;
  const { interval, setInterval, isLoading, isError } = dashboard;
  const { data: statusData } = useQuery({
    queryKey: ["poly-wallet-status"],
    queryFn: fetchWalletStatus,
    staleTime: 10_000,
    gcTime: 60_000,
    retry: 1,
  });
  const paperAccount = useMutation({
    mutationFn: createPaperAccount,
    onSuccess: async () => {
      await Promise.all([
        invalidateWalletDashboardSnapshot(queryClient),
        queryClient.invalidateQueries({ queryKey: ["poly-wallet-status"] }),
      ]);
    },
  });
  const isPaper = data?.account_kind === "paper";
  const hasPersistedConnection = dashboard.data?.readiness?.connected === true;

  const gasReading = data?.pol_gas;
  const hasGasReading = gasReading !== null && gasReading !== undefined;
  const lowGas =
    data?.connected === true && hasGasReading && gasReading <= 0.1;
  const noGas =
    data?.connected === true && hasGasReading && gasReading <= 0;
  const pnlHistoryUnavailable = data?.warnings.some((warning) =>
    [
      "pnl_history_wallet_missing",
      "pnl_history_unavailable",
      "pnl_history_stale",
    ].includes(warning.code)
  );
  const pnlHistoryMissing = data?.warnings.some(
    (warning) => warning.code === "pnl_history_no_history"
  );
  const hasPartialWarning = data?.warnings.some(
    (warning) => warning.code !== "pnl_history_no_history"
  );
  const balance = {
    available: data?.usdc_available ?? null,
    locked: data?.usdc_locked ?? null,
    positions: data?.usdc_positions_mtm ?? null,
    total: data?.usdc_total ?? null,
  };

  return (
    <Card>
      <CardHeader className="px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
            Trading Wallet
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {hasPartialWarning ? (
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
                title="Some wallet values are temporarily unavailable."
              >
                partial
              </span>
            ) : null}
            {lowGas ? (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5",
                  noGas
                    ? "bg-destructive/15 text-destructive"
                    : "bg-warning/15 text-warning"
                )}
                title={
                  noGas
                    ? "No POL balance — this wallet cannot pay gas."
                    : `Low POL — ${formatDecimal(data?.pol_gas ?? null, 4)}`
                }
              >
                {noGas ? "no gas" : "low gas"}
              </span>
            ) : null}
            {data?.connected && isPaper ? (
              <span className="rounded bg-primary/10 px-2 py-1 font-semibold text-primary">
                Paper account
              </span>
            ) : data?.connected && data.address ? (
              <AddressChip address={data.address} />
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pt-1 pb-4">
        {isLoading ? (
          <div className="space-y-4">
            <div className="h-12 animate-pulse rounded bg-muted" />
            <div className="h-48 animate-pulse rounded bg-muted" />
          </div>
        ) : isError || !data ? (
          <p className="py-2 text-muted-foreground text-sm">
            Couldn&apos;t load trading wallet. Will retry shortly.
          </p>
        ) : !data.connected && hasPersistedConnection ? (
          <OnboardingCta
            message="Your live trading wallet setup is incomplete."
            ctaLabel="Finish live setup →"
            href="/credits"
          />
        ) : !data.connected ? (
          <PaperAccountOnboarding
            isPending={paperAccount.isPending}
            isError={paperAccount.isError}
            onCreate={() => paperAccount.mutate()}
          />
        ) : !isPaper && !data.configured ? (
          <p className="py-2 text-muted-foreground text-sm">
            Trading-wallet adapter is not configured on this pod yet.
          </p>
        ) : !isPaper && statusData?.connected && !statusData.trading_ready ? (
          <OnboardingCta
            message="Trading not enabled — finish approvals to copy-trade."
            ctaLabel="Enable trading →"
            href="/credits"
          />
        ) : !isPaper && data.usdc_total !== null && data.usdc_total <= 0 ? (
          <OnboardingCta
            message="Wallet is empty — add USD collateral (pUSD or USDC.e) on Polygon to start trading."
            ctaLabel="Fund wallet →"
            href="/credits"
          />
        ) : (
          <div className="space-y-5 py-1">
            <div className="space-y-3">
              {balance.positions === null &&
              data.positions_stale &&
              formatSyncAge(data.positions_sync_age_ms) ? (
                // Only the genuine-stall case: positions were synced before
                // (non-null age) and are now withheld. A never-observed account
                // (null age) withholds too, but has no prior funds to have
                // "changed" — showing the reassurance there would be a false
                // alarm (bug.5031 review I2). Keying on `balance.positions ===
                // null` keeps "withheld below" literally true (I3).
                <div
                  className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-warning text-xs"
                  role="status"
                >
                  Live position data is stale (last synced{" "}
                  {formatSyncAge(data.positions_sync_age_ms)}). Open-position
                  value is withheld below — this is a data-sync delay, not a
                  change in your funds.
                </div>
              ) : null}
              <TradingWalletBalanceBar balance={balance} />
              <div className="flex flex-wrap items-center justify-between gap-3 text-muted-foreground text-xs">
                <span>
                  {data.open_orders === null
                    ? "Open orders —"
                    : `${data.open_orders} open order${data.open_orders === 1 ? "" : "s"}`}
                </span>
                <span>POL gas {formatDecimal(data.pol_gas, 4)}</span>
              </div>
            </div>
            <TimeWindowHeader
              interval={interval}
              onIntervalChange={setInterval}
              pnlHistory={data.pnlHistory}
            />
            {pnlHistoryUnavailable ? (
              <p className="text-muted-foreground text-xs" role="status">
                P/L temporarily unavailable.
              </p>
            ) : pnlHistoryMissing ? (
              <p className="text-muted-foreground text-xs" role="status">
                No P/L history has been recorded for this interval yet.
              </p>
            ) : null}
            {!pnlHistoryUnavailable ? (
              <WalletProfitLossCard
                history={data.pnlHistory}
                interval={interval}
              />
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PaperAccountOnboarding({
  isPending,
  isError,
  onCreate,
}: {
  isPending: boolean;
  isError: boolean;
  onCreate: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="text-muted-foreground text-sm">
        No trading account exists for this login yet.
      </p>
      <p className="max-w-xl text-muted-foreground text-xs">
        Start with a declared $10,000 simulated balance and safety caps of $20
        per order and $200 per day. No wallet, key, deposit, or real funds are
        created.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={isPending}
          onClick={onCreate}
        >
          {isPending ? "Starting paper account…" : "Start paper trading"}
        </Button>
        <Link
          href="/credits"
          className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-5 py-2 font-semibold text-primary text-sm transition-colors hover:bg-primary/20"
        >
          Connect live wallet →
        </Link>
      </div>
      {isError ? (
        <p className="text-destructive text-xs" role="alert">
          Paper account creation failed. Please retry.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Centered, primary-accented onboarding CTA shown when the caller hasn't yet
 * reached the next step (no wallet / !trading_ready). Matches the login
 * button's `bg-primary/10 border-primary/40 text-primary` treatment so it
 * reads as the obvious next action.
 */
function OnboardingCta({
  message,
  ctaLabel,
  href,
}: {
  message: string;
  ctaLabel: string;
  href: string;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="text-muted-foreground text-sm">{message}</p>
      <Link
        href={href}
        className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-5 py-2 font-semibold text-primary text-sm transition-colors hover:bg-primary/20"
      >
        {ctaLabel}
      </Link>
    </div>
  );
}
