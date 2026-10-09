// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/overview`
 * Purpose: HTTP GET — current dashboard summary for the calling user's
 *   Polymarket trading wallet: cash, live locked open-order notional,
 *   position MTM, total, and gas.
 * Scope: Read-only, session-authenticated, tenant-scoped. Does not provision
 *   wallets, place trades, or infer any historical balance curve.
 * Invariants:
 *   - TENANT_SCOPED: the caller's billing account is resolved from session.
 *   - CURRENT_ONLY: all values describe the current wallet state only.
 *   - PARTIAL_FAILURE_NEVER_THROWS: upstream failures degrade to nullable
 *     fields plus warnings while the route stays 200.
 *   - COALESCED_PAYLOAD (task.5013, SWR since the dashboard read-path
 *     floor fix): the post-auth payload computation is wrapped in the
 *     in-process `coalesceSwr` cache (fresh 20s / stale 5min via
 *     `coalesceDashboardRoutePayload`), keyed by billing account +
 *     interval + freshness. The dashboard's 30s tick serves the previous
 *     payload instantly and kicks one background recompute. Concurrent
 *     requests share one computation; thrown errors are never cached. The
 *     `listTenantPositions` + `readCurrentWalletPositionModel` reads are
 *     additionally shared with the execution route via their own SWR
 *     entries. Invalidated by POST /wallet/refresh via
 *     `invalidateDashboardRouteCaches`. SINGLE_REPLICA cache — see
 *     `@features/wallet-analysis/server/coalesce`.
 *   - CACHED_TENANT_RESOLUTION: the billing-account id is resolved through
 *     the short-TTL `resolveBillingAccountId` cache (identity is immutable
 *     per user), so a warm request runs zero pre-cache DB round-trips.
 *   - BALANCES_OFF_FIRST_PAINT (task.5010): the on-chain balance read
 *     (`adapter.getBalances` → 3 Polygon RPC calls) sits behind its own
 *     longer-TTL cache entry (`coalesceWalletBalances`,
 *     `WALLET_BALANCES_CACHE_TTL_MS` = 30s), so a cold/expired route-cache
 *     hit is served from warm balances instead of blocking first paint on
 *     chain RPC. Displayed cash/gas may therefore be up to 30s stale under
 *     BOTH freshness values (`read_model` and `live` differ only in
 *     pnlHistory computation — the response shape is unchanged). POST
 *     /wallet/refresh evicts the balances key, so the refresh button
 *     always yields fresh on-chain numbers. Degraded reads (RPC error or
 *     timeout → null legs + `balances_partial` warning) are never pinned
 *     for the 30s TTL (BALANCES_DEGRADED_NOT_CACHED).
 * Side-effects: IO (DB read, Polygon RPC, optional Data API).
 * @public
 */

import {
  type PolyWalletOverviewOutput,
  polyWalletOverviewOperation,
} from "@cogni/poly-node-contracts";
import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { isPolyTraderWalletConfigured } from "@/bootstrap/poly-trader-wallet";
import { readCurrentWalletPositionModel } from "@/features/wallet-analysis/server/current-position-read-model";
import { getTradingWalletPnlHistoryRead } from "@/features/wallet-analysis/server/trading-wallet-overview-service";
import {
  readWalletBalanceFact,
  hasTradingWallet,
  WALLET_BALANCE_FRESHNESS_MS,
} from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { resolveBillingAccountId } from "../../_lib/billing-account-cache";
import {
  availableCashAfterReservations,
  sumCashOnChain,
  sumWalletTotal,
} from "../_lib/cash-on-chain";
import {
  coalesceCurrentWalletPositions,
  coalesceDashboardRoutePayload,
  coalesceTenantLedgerPositions,
  overviewRouteCacheKey,
} from "../_lib/dashboard-route-cache";
import {
  DASHBOARD_LEDGER_POSITION_LIMIT,
  DASHBOARD_LEDGER_POSITION_STATUSES,
  summarizeLedgerOrders,
} from "../_lib/ledger-positions";
import { walletCompletionDiagnostics } from "../_lib/wallet-completion-diagnostics";

export const dynamic = "force-dynamic";

function emptyPayload(
  interval: PolyWalletOverviewOutput["interval"],
  capturedAt: string,
  overrides: Partial<PolyWalletOverviewOutput>
): PolyWalletOverviewOutput {
  return polyWalletOverviewOperation.output.parse({
    configured: true,
    connected: false,
    account_kind: null,
    freshness: overrides.freshness ?? "live",
    address: null,
    interval,
    capturedAt,
    pol_gas: null,
    usdc_available: null,
    usdc_locked: null,
    usdc_positions_mtm: null,
    usdc_total: null,
    open_orders: null,
    positions_synced_at: null,
    positions_sync_age_ms: null,
    positions_stale: false,
    pnlHistory: [],
    warnings: [],
    ...overrides,
  });
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.wallet.overview",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAtMs = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");
    const url = new URL(request.url);
    const { interval = "1W", freshness } =
      polyWalletOverviewOperation.input.parse({
        interval: url.searchParams.get("interval") ?? undefined,
        freshness: url.searchParams.get("freshness") ?? undefined,
      });
    const container = getContainer();
    // CACHED_TENANT_RESOLUTION: warm hit = 0 DB round-trips; cold hit = one
    // transaction-free SELECT (create branch only on genuine first request).
    const billingAccountId = await resolveBillingAccountId(
      container.serviceAccountService,
      sessionUser.id
    );

    // COALESCED_PAYLOAD (task.5013, SWR): everything below — adapter
    // resolution, balances, position read models, pnl history — is served
    // from cache when fresh; a stale hit (every 30s dashboard tick) returns
    // the previous payload and kicks ONE background recompute per
    // (billing account, interval, freshness) key. Errors reject the
    // in-flight promise and are evicted (never cached); partial-success
    // payloads carrying warnings ARE cached by design.
    const payload = await coalesceDashboardRoutePayload<PolyWalletOverviewOutput>(
      overviewRouteCacheKey(billingAccountId, interval, freshness),
      async () => {
        const requestedAt = new Date();
        const appDb = resolveAppDb() as unknown as PostgresJsDatabase<
          Record<string, unknown>
        >;
        const balances = await withTenantScope(
          appDb,
          userActor(toUserId(sessionUser.id)),
          async (tx) => readWalletBalanceFact(tx, billingAccountId)
        );
        if (!hasTradingWallet(balances)) {
          logOverviewComplete(ctx, startedAtMs, {
            status: "no_trading_wallet",
            interval,
            freshness,
            connected: false,
            warnings: ["no_trading_wallet"],
            openOrders: null,
            positionsMtm: null,
            lockedUsdc: null,
            pnlPoints: 0,
          });
          return emptyPayload(interval, requestedAt.toISOString(), {
            configured: isPolyTraderWalletConfigured(),
            connected: false,
            address: null,
            freshness,
            warnings: [
              {
                code: "no_trading_wallet",
                message:
                  "No Polymarket trading wallet is provisioned for this account.",
              },
            ],
          });
        }

        const balanceStale =
          balances.kind === "available" &&
          requestedAt.getTime() - balances.observedAt.getTime() >
            WALLET_BALANCE_FRESHNESS_MS;
        const capturedAt = requestedAt.toISOString();
        const warnings: PolyWalletOverviewOutput["warnings"] = [];
        if (balances.kind === "missing") {
          warnings.push({
            code: "balance_snapshot_missing",
            message:
              "No persisted wallet balance observation is available yet; this is not a zero balance.",
          });
        } else {
          warnings.push(
            ...balances.errors.map((message: string) => ({
              code:
                balances.status === "error"
                  ? "balances_unavailable"
                  : "balances_partial",
              message,
            }))
          );
        }
        if (balances.kind === "available" && balanceStale) {
          warnings.push({
            code: "balances_stale",
            message: `Wallet balances are older than the 10-minute freshness window (observed ${balances.observedAt.toISOString()}).`,
          });
        } else if (
          balances.kind === "available" &&
          balances.status === "error"
        ) {
          warnings.push({
            code: "balances_unavailable",
            message: "All persisted on-chain balance legs are unavailable.",
          });
        }

        const capturedAtDate = requestedAt;
        // Null means the ledger read itself failed. A successful read with no
        // rows produces a real zero summary; those states must not collapse.
        let positionSummary: ReturnType<typeof summarizeLedgerOrders> | null =
          null;
        let currentPositionSummary: {
          positionsMtm: number;
          syncedAt: string | null;
          syncAgeMs: number | null;
          stale: boolean;
        } | null = null;
        try {
          // SHARED_READ: byte-identical to the execution route's ledger
          // read — one SWR entry serves both routes (dashboard floor fix).
          const rows = await coalesceTenantLedgerPositions(billingAccountId, () =>
            container.orderLedger.listTenantPositions({
              billing_account_id: billingAccountId,
              statuses: [...DASHBOARD_LEDGER_POSITION_STATUSES],
              limit: DASHBOARD_LEDGER_POSITION_LIMIT,
            })
          );
          positionSummary = summarizeLedgerOrders(rows, capturedAtDate);
        } catch (err) {
          warnings.push({
            code: "positions_read_model_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
        }

        try {
          // SHARED_READ: same model the execution route reads — one
          // SWR entry serves both routes (dashboard floor fix).
          const currentPositions = await coalesceCurrentWalletPositions(
            billingAccountId,
            balances.address,
            () =>
              readCurrentWalletPositionModel({
                db: container.serviceDb,
                walletAddress: balances.address,
                capturedAt: capturedAtDate,
              })
          );
          if (
            !currentPositions.warnings.some(
              (warning) => warning.code === "current_positions_wallet_missing"
            )
          ) {
            currentPositionSummary = currentPositions.summary;
          }
          warnings.push(...currentPositions.warnings);
        } catch (err) {
          warnings.push({
            code: "current_positions_read_model_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        // Cash is live RPC; positionsMtm is a DB cache. A stale cache + live cash
        // mis-attributes new mirror buys (cash debited, position not yet in DB) as
        // wallet shrinkage. Null > stale, so the dashboard degrades to "—".
        const positionsMtm =
          currentPositionSummary !== null && !currentPositionSummary.stale
            ? roundToCents(currentPositionSummary.positionsMtm)
            : null;

        // `balances.usdcE` and `balances.pusd` are the wallet's two on-chain cash
        // balances (USDC.e bridged + Polymarket V2 pUSD). Both are spendable from
        // the dashboard's perspective: pUSD funds CLOB BUYs directly; USDC.e is
        // wrapped to pUSD by the auto-wrap loop when consent is on. Post the
        // 2026-04-28 collateral cutover, pUSD is where a funded wallet's balance
        // actually lives, so it MUST be summed into cash — reading only USDC.e
        // reports a funded wallet as empty (the pUSD-collateral bug).
        // Open orders are software-level reservations, so DB-derived locked USDC is
        // already part of the on-chain cash balance.
        // COLLATERAL_SUM_IS_NULL_SAFE: sum whichever legs read successfully; a
        // single failed RPC read (one token null, the other a real balance) must
        // never zero out the wallet. Cash is null only when NO on-chain read
        // succeeded (both null → RPC down / unconfigured), so the dashboard
        // degrades to "—" instead of falsely claiming an empty wallet.
        const cashOnChain = balances.kind !== "available" || balanceStale
          ? null
          : sumCashOnChain(balances.usdcE, balances.pusd);
        const availableRaw = availableCashAfterReservations(
          cashOnChain,
          positionSummary?.lockedUsdc ?? null
        );
        const usdcAvailable =
          availableRaw !== null ? roundToCents(availableRaw) : null;
        // TOTAL_REQUIRES_COMPLETE_INVENTORY (see sumWalletTotal): cash remains
        // independently visible, but a cash-only subtotal must never be labeled
        // Total while the position inventory is absent or stale.
        const totalRaw = sumWalletTotal(cashOnChain, positionsMtm);
        const total = totalRaw !== null ? roundToCents(totalRaw) : null;
        let pnlHistory: PolyWalletOverviewOutput["pnlHistory"] = [];
        if (freshness === "live") {
          try {
            const pnlRead = await getTradingWalletPnlHistoryRead({
              db: container.serviceDb,
              address: balances.address,
              interval,
              capturedAt,
            });
            pnlHistory = pnlRead.points;
            if (pnlRead.status === "wallet_missing") {
              warnings.push({
                code: "pnl_history_wallet_missing",
                message:
                  "P/L history is unavailable because this trading wallet is not enrolled in the observer read model.",
              });
            } else if (pnlRead.status === "no_history") {
              warnings.push({
                code: "pnl_history_no_history",
                message:
                  "No saved P/L history is available for the selected interval yet.",
              });
            } else if (pnlRead.status === "stale") {
              pnlHistory = [];
              warnings.push({
                code: "pnl_history_stale",
                message: `Saved P/L history is older than the 10-minute freshness window (last observed ${pnlRead.observedAt ?? "unknown"}).`,
              });
            }
          } catch (err) {
            warnings.push({
              code: "pnl_history_unavailable",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }

        logOverviewComplete(ctx, startedAtMs, {
          status: warnings.some(
            (warning) => warning.code === "positions_read_model_unavailable"
          )
            ? "positions_read_model_unavailable"
            : warnings.some(
                  (warning) =>
                    warning.code === "current_positions_wallet_missing"
                )
              ? "current_positions_wallet_missing"
              : warnings.some(
                    (warning) =>
                      warning.code ===
                      "current_positions_read_model_unavailable"
                  )
                ? "current_positions_read_model_unavailable"
                : warnings.some(
                      (warning) => warning.code === "current_positions_stale"
                    )
                  ? "current_positions_stale"
                  : warnings.some(
                        (warning) =>
                          warning.code === "pnl_history_unavailable" ||
                          warning.code === "pnl_history_wallet_missing"
                      )
                    ? "pnl_history_unavailable"
                    : warnings.some(
                          (warning) => warning.code === "pnl_history_stale"
                        )
                      ? "pnl_history_stale"
                    : warnings.some(
                          (warning) =>
                            warning.code === "pnl_history_no_history"
                        )
                      ? "pnl_history_no_history"
                      : warnings.some(
                            (warning) => warning.code === "balances_partial"
                          )
                        ? "balances_partial"
                        : "ok",
          interval,
          freshness,
          connected: true,
          warnings: warnings.map((warning) => warning.code),
          openOrders: positionSummary?.openOrders ?? null,
          positionsMtm,
          lockedUsdc: positionSummary?.lockedUsdc ?? null,
          pnlPoints: pnlHistory.length,
        });

        return polyWalletOverviewOperation.output.parse({
          configured: isPolyTraderWalletConfigured(),
          connected: true,
          account_kind: balances.connectionKind,
          freshness,
          address: balances.address,
          interval,
          capturedAt,
          pol_gas:
            balances.kind !== "available" || balanceStale
              ? null
              : balances.pol,
          usdc_available: usdcAvailable,
          usdc_locked: positionSummary?.lockedUsdc ?? null,
          usdc_positions_mtm: positionsMtm,
          usdc_total: total,
          open_orders: positionSummary?.openOrders ?? null,
          positions_synced_at:
            currentPositionSummary?.syncedAt ??
            positionSummary?.syncedAt ??
            null,
          positions_sync_age_ms:
            currentPositionSummary?.syncAgeMs ??
            positionSummary?.syncAgeMs ??
            null,
          positions_stale:
            currentPositionSummary?.stale ?? positionSummary?.stale ?? false,
          pnlHistory,
          warnings,
        });
      }
    );

    return NextResponse.json(payload);
  }
);

function logOverviewComplete(
  ctx: {
    log: Parameters<typeof logEvent>[0];
    reqId: string;
    routeId: string;
  },
  startedAtMs: number,
  fields: {
    status: string;
    interval: PolyWalletOverviewOutput["interval"];
    freshness: PolyWalletOverviewOutput["freshness"];
    connected: boolean;
    warnings: readonly string[];
    openOrders: number | null;
    positionsMtm: number | null;
    lockedUsdc: number | null;
    pnlPoints: number;
  }
): void {
  const diagnostics = walletCompletionDiagnostics(
    fields.status,
    fields.warnings
  );
  logEvent(ctx.log, EVENT_NAMES.POLY_WALLET_OVERVIEW_COMPLETE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: diagnostics.status,
    durationMs: Math.round(performance.now() - startedAtMs),
    outcome: "success",
    interval: fields.interval,
    freshness: fields.freshness,
    connected: fields.connected,
    warnings: diagnostics.warnings,
    warning_codes: diagnostics.warning_codes,
    open_orders: fields.openOrders,
    positions_mtm: fields.positionsMtm,
    locked_usdc: fields.lockedUsdc,
    pnl_points: fields.pnlPoints,
  });
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
