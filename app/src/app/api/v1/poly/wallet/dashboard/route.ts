// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Authenticated, DB-only coherent wallet-dashboard snapshot. */
import {
  PolyWalletDashboardOutputSchema,
  polyWalletDashboardOperation,
} from "@cogni/poly-node-contracts";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import {
  getContainer,
  resolveServiceReadDb,
} from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { isPolyTraderWalletConfigured } from "@/bootstrap/poly-trader-wallet";
import { readTenantWalletDashboard } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import { serverEnv } from "@/shared/env/server-env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { resolveBillingAccountId } from "../../_lib/billing-account-cache";
import {
  coalesceUnifiedDashboard,
  unifiedDashboardCacheKey,
} from "../_lib/dashboard-route-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.wallet.dashboard",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");
    const url = new URL(request.url);
    const query = polyWalletDashboardOperation.input.safeParse({
      interval: url.searchParams.get("interval") ?? undefined,
    });
    if (!query.success) {
      logDashboardError(ctx, startedAt, 400, "invalid_query");
      return NextResponse.json(
        { error: "invalid_query", message: query.error.message },
        { status: 400 }
      );
    }

    let dashboard: unknown;
    try {
      const container = getContainer();
      const billingAccountId = await resolveBillingAccountId(
        container.serviceAccountService,
        sessionUser.id
      );
      const db = resolveServiceReadDb() as unknown as PostgresJsDatabase<
        Record<string, unknown>
      >;
      dashboard = await coalesceUnifiedDashboard(
        unifiedDashboardCacheKey(billingAccountId, query.data.interval),
        () =>
          readTenantWalletDashboard({
            db,
            billingAccountId,
            interval: query.data.interval,
            adapterConfigured: isPolyTraderWalletConfigured(),
          })
      );
    } catch {
      logDashboardError(ctx, startedAt, 500, "service_failed");
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
    const parsed = PolyWalletDashboardOutputSchema.safeParse(dashboard);
    if (!parsed.success) {
      logDashboardError(ctx, startedAt, 500, "response_validation_failed");
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
    const response = parsed.data;
    const degraded =
      response.warnings.length > 0 ||
      Object.values(response.facts).some((fact) => fact.status !== "fresh");

    logEvent(ctx.log, EVENT_NAMES.POLY_WALLET_DASHBOARD_COMPLETE, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      buildSha: serverEnv().APP_BUILD_SHA ?? "unknown",
      snapshotId: response.snapshotId,
      capturedAt: response.capturedAt,
      interval: response.interval,
      walletStatus: response.facts.wallet.status,
      walletSource: response.facts.wallet.source,
      walletAgeMs: response.facts.wallet.ageMs,
      walletComplete: response.facts.wallet.complete,
      cashStatus: response.facts.cash.status,
      cashSource: response.facts.cash.source,
      cashAgeMs: response.facts.cash.ageMs,
      cashComplete: response.facts.cash.complete,
      orderStatus: response.facts.orders.status,
      orderSource: response.facts.orders.source,
      orderAgeMs: response.facts.orders.ageMs,
      orderComplete: response.facts.orders.complete,
      positionStatus: response.facts.positions.status,
      positionSource: response.facts.positions.source,
      positionAgeMs: response.facts.positions.ageMs,
      positionComplete: response.facts.positions.complete,
      historyStatus: response.facts.history.status,
      historySource: response.facts.history.source,
      historyAgeMs: response.facts.history.ageMs,
      historyComplete: response.facts.history.complete,
      pnlStatus: response.facts.pnl.status,
      pnlSource: response.facts.pnl.source,
      pnlAgeMs: response.facts.pnl.ageMs,
      pnlComplete: response.facts.pnl.complete,
      activityStatus: response.facts.activity.status,
      activitySource: response.facts.activity.source,
      activityAgeMs: response.facts.activity.ageMs,
      activityComplete: response.facts.activity.complete,
      marketsStatus: response.facts.markets.status,
      marketsSource: response.facts.markets.source,
      marketsAgeMs: response.facts.markets.ageMs,
      marketsComplete: response.facts.markets.complete,
      totalStatus: response.facts.total.status,
      totalSource: response.facts.total.source,
      totalAgeMs: response.facts.total.ageMs,
      totalComplete: response.facts.total.complete,
      openOrders: response.overview.open_orders,
      livePositionCount: response.execution.live_position_count,
      closedPositionCount: response.execution.closed_position_count,
      cashUsdc: response.overview.usdc_available,
      positionsMtmUsdc: response.overview.usdc_positions_mtm,
      totalUsdc: response.overview.usdc_total,
      warningCodes: response.warnings.map((entry) => entry.code),
      durationMs: Math.round(performance.now() - startedAt),
      status: 200,
      outcome: degraded ? "degraded" : "success",
      degraded,
    });

    return NextResponse.json(response, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Wallet-Snapshot-Id": response.snapshotId,
        "X-Request-Id": ctx.reqId ?? "unknown",
      },
    });
  }
);

function logDashboardError(
  ctx: {
    log: Parameters<typeof logEvent>[0];
    reqId: string;
    routeId: string;
  },
  startedAt: number,
  status: 400 | 500,
  errorCode: "invalid_query" | "service_failed" | "response_validation_failed"
): void {
  logEvent(ctx.log, EVENT_NAMES.POLY_WALLET_DASHBOARD_COMPLETE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    buildSha: serverEnv().APP_BUILD_SHA ?? "unknown",
    durationMs: Math.round(performance.now() - startedAt),
    status,
    outcome: "error",
    degraded: true,
    errorCode,
    warningCodes: [],
  });
}
