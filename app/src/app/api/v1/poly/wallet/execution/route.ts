// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/execution`
 * Purpose: HTTP GET — per-tenant execution feed (positions + daily trade
 *          counts) for the caller's own Polymarket trading wallet. Powers the dashboard's
 *          `OperatorWalletChartsRow` + `ExecutionActivityCard`.
 * Scope: Session-auth, tenant-scoped. Resolves the caller's billing account,
 *   resolves its presentation wallet from saved account facts, then reads the
 *   local position model. Paper and live therefore share one response shape
 *   without a paper page load touching the private live-wallet adapter.
 * Invariants:
 *   - TENANT_SCOPED: the caller's own wallet is the only thing this route
 *     ever reads. The route has no query-parameter escape hatch.
 *   - CONTRACT_STABLE: response shape matches
 *     `polyWalletExecutionOperation.output`. When the tenant has no trading
 *     wallet provisioned yet, the payload is empty arrays with a warning —
 *     the UI empty state renders without throwing.
 *   - ACCOUNT_VENUE_OWNS_PRIVATE_READS: the selected connection row chooses
 *     the address. Paper reads its durable simulator projection; live reads
 *     its durable live projection. This route never asks a signer/custody
 *     adapter which wallet exists.
 *   - EXECUTION_ONLY: current wallet totals live on
 *     `/api/v1/poly/wallet/overview`; this route stays focused on positions
 *     and trade cadence only.
 *   - BOUNDED_HISTORY_PAYLOAD: closed/redeemed history is preview data for the
 *     dashboard, not an unbounded archive export.
 *   - COALESCED_PAYLOAD (task.5013, SWR since the dashboard read-path
 *     floor fix): the post-auth payload computation is wrapped in the
 *     in-process `coalesceSwr` cache (fresh 20s / stale 5min via
 *     `coalesceDashboardRoutePayload`), keyed by billing account only —
 *     `freshness` never gates computation here and is re-stamped per
 *     request. The dashboard's 30s tick serves the previous payload
 *     instantly and kicks one background recompute. Concurrent requests
 *     share one computation; thrown errors are never cached. The
 *     `listTenantPositions` + `readCurrentWalletPositionModel` reads are
 *     additionally shared with the overview route via their own SWR
 *     entries. Invalidated by POST /wallet/refresh via
 *     `invalidateDashboardRouteCaches`. SINGLE_REPLICA cache — see
 *     `@features/wallet-analysis/server/coalesce`.
 *   - CACHED_TENANT_RESOLUTION: the billing-account id is resolved through
 *     the short-TTL `resolveBillingAccountId` cache (identity is immutable
 *     per user), so a warm request runs zero pre-cache DB round-trips.
 * Side-effects: IO (DB reads only).
 * Links: nodes/poly/packages/node-contracts/src/poly.wallet.execution.v1.contract.ts,
 *        docs/spec/poly-tenant-and-collateral.md,
 *        work/items/task.0354.poly-trading-hardening-followups.md
 * @public
 */

import {
  type PolyWalletExecutionOutput,
  PolyWalletExecutionOutputSchema,
  polyWalletExecutionOperation,
} from "@cogni/poly-node-contracts";
import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { readCurrentWalletPositionModel } from "@/features/wallet-analysis/server/current-position-read-model";
import { buildMarketExposureGroups } from "@/features/wallet-analysis/server/market-exposure-service";
import {
  applyRealizedPnl,
  readWalletTokenPnlMap,
} from "@/features/wallet-analysis/server/realized-pnl-service";
import {
  hasTradingWallet,
  readWalletBalanceFact,
} from "@/features/wallet-analysis/server/wallet-balance-snapshot-service";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { resolveBillingAccountId } from "../../_lib/billing-account-cache";
import {
  coalesceCurrentWalletPositions,
  coalesceDashboardRoutePayload,
  coalesceTenantLedgerPositions,
  executionRouteCacheKey,
} from "../_lib/dashboard-route-cache";
import {
  coalesceWalletExecutionPositions,
  DASHBOARD_LEDGER_POSITION_LIMIT,
  DASHBOARD_LEDGER_POSITION_STATUSES,
  DASHBOARD_TRADE_COUNT_WINDOW_DAYS,
  toWalletExecutionPosition,
} from "../_lib/ledger-positions";
import { walletCompletionDiagnostics } from "../_lib/wallet-completion-diagnostics";

export const dynamic = "force-dynamic";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const EXECUTION_HISTORY_LIMIT = 30;

function emptyPayload(
  freshness: PolyWalletExecutionOutput["freshness"],
  warning: { code: string; message: string }
) {
  return polyWalletExecutionOperation.output.parse({
    address: ZERO_ADDRESS,
    freshness,
    capturedAt: new Date().toISOString(),
    dailyTradeCounts: [],
    live_positions: [],
    market_groups: [],
    closed_positions: [],
    warnings: [warning],
  });
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.wallet.execution",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAtMs = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");
    const url = new URL(request.url);
    const { freshness } = polyWalletExecutionOperation.input.parse({
      freshness: url.searchParams.get("freshness") ?? undefined,
    });

    const container = getContainer();
    // CACHED_TENANT_RESOLUTION: warm hit = 0 DB round-trips; cold hit = one
    // transaction-free SELECT (create branch only on genuine first request).
    const billingAccountId = await resolveBillingAccountId(
      container.serviceAccountService,
      sessionUser.id
    );

    // COALESCED_PAYLOAD (task.5013, SWR): everything below — saved account
    // resolution, realized P/L, ledger + current-position read models,
    // market groups — is served from cache when fresh; a stale hit (every
    // 30s dashboard tick) returns the previous payload and kicks ONE
    // background recompute. Errors reject the in-flight promise and are
    // evicted (never cached); partial-success payloads carrying warnings
    // ARE cached by design. `freshness` never gates computation on this
    // route, so it is excluded from the key and re-stamped below.
    const payload = await coalesceDashboardRoutePayload<PolyWalletExecutionOutput>(
      executionRouteCacheKey(billingAccountId),
      async () => {
        const appDb = resolveAppDb() as unknown as PostgresJsDatabase<
          Record<string, unknown>
        >;
        const wallet = await withTenantScope(
          appDb,
          userActor(toUserId(sessionUser.id)),
          async (tx) => readWalletBalanceFact(tx, billingAccountId)
        );
        if (!hasTradingWallet(wallet)) {
          logEvent(ctx.log, EVENT_NAMES.POLY_WALLET_EXECUTION_COMPLETE, {
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            ...walletCompletionDiagnostics("no_trading_wallet", [
              "no_trading_wallet",
            ]),
            durationMs: Math.round(performance.now() - startedAtMs),
            outcome: "success",
            freshness,
            live_positions: 0,
            closed_positions: 0,
            daily_trade_days: 0,
          });
          return emptyPayload(freshness, {
            code: "no_trading_wallet",
            message:
              "No Polymarket trading wallet is provisioned for this account. Connect one from the Money page.",
          });
        }
        const address = wallet.address;

        const capturedAt = new Date();
        const warnings: Array<{ code: string; message: string }> = [];
        let livePositions: PolyWalletExecutionOutput["live_positions"] = [];
        let livePositionCount: number | undefined;
        let closedPositions: PolyWalletExecutionOutput["closed_positions"] = [];
        let dailyTradeCounts: Array<{ day: string; n: number }> = [];
        const ledgerLiveByAsset = new Map<
          string,
          PolyWalletExecutionOutput["live_positions"][number]
        >();
        // Canonical fills + outcomes realized-P/L for this wallet. Fetched
        // once and threaded into every consumer so the dashboard's positions
        // list, markets aggregator, and ledger overlay all derive P/L from
        // the same source. Soft-fails to an empty map — read-models then fall
        // back to unrealized MTM, preserving pre-fix display rather than 500.
        const realizedPnlMap = await readWalletTokenPnlMap({
          db: container.serviceDb,
          walletAddress: address,
        }).catch((err: unknown) => {
          warnings.push({
            code: "realized_pnl_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
          return new Map();
        });
        {
          const [rowsResult, dailyCountsResult] = await Promise.allSettled([
            coalesceTenantLedgerPositions(billingAccountId, () =>
              container.orderLedger.listTenantPositions({
                billing_account_id: billingAccountId,
                statuses: [...DASHBOARD_LEDGER_POSITION_STATUSES],
                limit: DASHBOARD_LEDGER_POSITION_LIMIT,
              })
            ),
            container.orderLedger.dailyTradeCounts({
              billing_account_id: billingAccountId,
              capturedAt,
              windowDays: DASHBOARD_TRADE_COUNT_WINDOW_DAYS,
            }),
          ]);
          if (dailyCountsResult.status === "fulfilled") {
            dailyTradeCounts = dailyCountsResult.value;
          } else {
            warnings.push({
              code: "daily_trade_counts_unavailable",
              message:
                dailyCountsResult.reason instanceof Error
                  ? dailyCountsResult.reason.message
                  : String(dailyCountsResult.reason),
            });
          }
          if (rowsResult.status === "rejected") {
            warnings.push({
              code: "positions_read_model_unavailable",
              message:
                rowsResult.reason instanceof Error
                  ? rowsResult.reason.message
                  : String(rowsResult.reason),
            });
          } else {
            const rows = rowsResult.value;
            const positions = rows.map((row) =>
              toWalletExecutionPosition(row, capturedAt)
            );
            // Realized P/L is overlaid LATER (after all sources are merged) so
            // the additive `mergeWalletExecutionPosition` can't double-count a
            // token-level credit that's already applied to both the ledger row
            // and the current-position row.
            const ledgerLivePositions = coalesceWalletExecutionPositions(
              positions
                .filter((position) => position.status !== "closed")
                .filter((position) => position.currentValue > 0)
            );
            for (const position of ledgerLivePositions) {
              ledgerLiveByAsset.set(position.asset, position);
            }
            closedPositions = coalesceWalletExecutionPositions(
              positions.filter((position) => position.status === "closed")
            );
          }
        }

        try {
          // SHARED_READ: same model the overview route reads — one
          // SWR entry serves both routes (dashboard floor fix).
          const currentPositions = await coalesceCurrentWalletPositions(
            billingAccountId,
            address,
            () =>
              readCurrentWalletPositionModel({
                db: container.serviceDb,
                billingAccountId,
                walletAddress: address,
                capturedAt,
              })
          );
          const currentLivePositions = currentPositions.positions.filter(
            (position) => position.status !== "closed" && position.currentValue > 0
          );
          livePositionCount = currentPositions.summary.activeRows;
          if (livePositionCount > currentLivePositions.length) {
            warnings.push({
              code: "positions_preview_truncated",
              message: `Showing ${currentLivePositions.length} of ${livePositionCount} open positions.`,
            });
          }
          const currentClosedPositions = currentPositions.positions.filter(
            (position) => position.status === "closed" || position.currentValue <= 0
          );
          livePositions = currentLivePositions.map((position) => {
            const ledgerPosition = ledgerLiveByAsset.get(position.asset);
            if (ledgerPosition === undefined) return position;
            return {
              ...position,
              status: ledgerPosition.status,
              lifecycleState: ledgerPosition.lifecycleState,
              openedAt: ledgerPosition.openedAt,
              closedAt: ledgerPosition.closedAt,
              gameStartTime: position.gameStartTime ?? ledgerPosition.gameStartTime,
              heldMinutes: ledgerPosition.heldMinutes,
              timeline:
                ledgerPosition.timeline.length > 0
                  ? ledgerPosition.timeline
                  : position.timeline,
              events:
                ledgerPosition.events.length > 0
                  ? ledgerPosition.events
                  : position.events,
            };
          });
          const currentAssets = new Set(
            currentPositions.positions.map((position) => position.asset)
          );
          closedPositions = coalesceWalletExecutionPositions(
            [
              ...closedPositions.filter(
                (position) => !currentAssets.has(position.asset)
              ),
              ...currentClosedPositions,
            ].filter((position) => position.status === "closed")
          );
          warnings.push(...currentPositions.warnings);
        } catch (err) {
          warnings.push({
            code: "current_positions_read_model_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        // Single overlay point. Both `livePositions` and `closedPositions`
        // arrived here from a merge that summed per-row unrealized P/L;
        // applying the canonical fills+outcomes P/L here is the single source
        // of truth for the dashboard. The markets aggregator below has its
        // own rollup query and is independent of this overlay.
        livePositions = applyRealizedPnl(livePositions, realizedPnlMap);
        closedPositions = applyRealizedPnl(closedPositions, realizedPnlMap);
        const marketGroups = await buildMarketExposureGroups({
          db: container.serviceDb,
          billingAccountId,
          walletAddress: address,
          livePositions,
          closedPositions,
        }).catch((err: unknown) => {
          warnings.push({
            code: "market_exposure_unavailable",
            message: err instanceof Error ? err.message : String(err),
          });
          return [];
        });

        const closedPositionsForResponse = closedPositions.slice(
          0,
          EXECUTION_HISTORY_LIMIT
        );

        logEvent(ctx.log, EVENT_NAMES.POLY_WALLET_EXECUTION_COMPLETE, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          ...walletCompletionDiagnostics(
            warnings.some(
              (warning) => warning.code === "positions_read_model_unavailable"
            )
              ? "positions_read_model_unavailable"
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
                  : "ok",
            warnings.map((warning) => warning.code)
          ),
          durationMs: Math.round(performance.now() - startedAtMs),
          outcome: "success",
          freshness,
          live_positions: livePositions.length,
          market_groups: marketGroups.length,
          closed_positions: closedPositionsForResponse.length,
          closed_positions_total: closedPositions.length,
          daily_trade_days: dailyTradeCounts.length,
        });

        return PolyWalletExecutionOutputSchema.parse({
          address: address.toLowerCase(),
          freshness,
          capturedAt: capturedAt.toISOString(),
          dailyTradeCounts,
          live_positions: livePositions,
          live_position_count: livePositionCount,
          market_groups: marketGroups,
          closed_positions: closedPositionsForResponse,
          warnings,
        });
      }
    );

    // `freshness` is echo-only on this route (never gates computation), and
    // the cache key excludes it — re-stamp per request so a cache hit never
    // echoes another request's freshness value.
    return NextResponse.json({ ...payload, freshness });
  }
);
