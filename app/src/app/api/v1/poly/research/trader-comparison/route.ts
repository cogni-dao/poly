// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/research/trader-comparison/route`
 * Purpose: HTTP GET for the research trader-comparison board.
 * Scope: Thin handler. Auth via getSessionUser, Zod query validation, service DB aggregation, response validation.
 * Invariants: Caps comparisons to three wallets through the contract; partial P/L failures return warnings with a 200.
 *   SWR_CACHED (fix/comparison-per-wallet-cache): served through the per-WALLET
 *   serve-stale-while-revalidate cache in `research-read-cache.ts` (5min fresh / 60min
 *   serve-stale, keyed `research:comparison-wallet:{addr}:{interval}` — labels are
 *   presentation, re-stamped at assembly, never in the key). The two fixed research targets
 *   are kept warm by the recurring prewarm tick, so any user's page = 2 warm targets + their
 *   own wallet. Staleness is acceptable — research aggregate over observed history.
 *   The per-wallet aggregate is rollup-backed with the flows fragment pushed down to the
 *   windowed-buy condition set (fix/comparison-flows-pushdown; previously it materialized the
 *   wallet's lifetime rollup per interval — 25.7s cold for RN1 on prod 2026-10-06).
 *   A wallet exceeding the `POLY_RESEARCH_WALLET_BUDGET_MS` budget (default 8s, matching
 *   DEFAULT_TRADER_COMPARISON_WALLET_BUDGET_MS) is omitted with a `wallet_budget_exceeded`
 *   warning on the partial-failure-200 path instead of letting the edge 520; budget-degraded
 *   per-wallet results are served but never SWR-cached (DEGRADED_NOT_PINNED).
 * Side-effects: DB reads and public Polymarket P/L reads via the feature service.
 * Links: nodes/poly/packages/node-contracts/src/poly.research-trader-comparison.v1.contract.ts
 * @public
 */

import {
  PolyResearchTraderComparisonQuerySchema,
  PolyResearchTraderComparisonResponseSchema,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceReadDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getTraderComparisonCached } from "@/features/wallet-analysis/server/research-read-cache";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research-trader-comparison",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");
    const url = new URL(request.url);
    const queryParse = PolyResearchTraderComparisonQuerySchema.safeParse({
      wallet: url.searchParams.getAll("wallet"),
      label: url.searchParams.getAll("label"),
      interval: url.searchParams.get("interval") ?? undefined,
    });
    if (!queryParse.success) {
      logTraderComparisonComplete(ctx, {
        startedAt,
        status: 400,
        outcome: "error",
        errorCode: "invalid_query",
        walletCount: 0,
        traderCount: 0,
        warningCount: 0,
      });
      return NextResponse.json(
        { error: "invalid_query", message: queryParse.error.message },
        { status: 400 }
      );
    }

    const db =
      resolveServiceReadDb() as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
        Record<string, unknown>
      >;
    let response: Awaited<ReturnType<typeof getTraderComparisonCached>>;
    try {
      response = await getTraderComparisonCached(
        db,
        queryParse.data.wallet.map((address, index) => ({
          address,
          label: queryParse.data.label[index],
        })),
        queryParse.data.interval
      );
    } catch {
      logTraderComparisonComplete(ctx, {
        startedAt,
        status: 500,
        outcome: "error",
        errorCode: "service_failed",
        walletCount: queryParse.data.wallet.length,
        traderCount: 0,
        warningCount: 0,
      });
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }

    const parsed =
      PolyResearchTraderComparisonResponseSchema.safeParse(response);
    if (!parsed.success) {
      logTraderComparisonComplete(ctx, {
        startedAt,
        status: 500,
        outcome: "error",
        errorCode: "response_validation_failed",
        walletCount: queryParse.data.wallet.length,
        traderCount: response.traders.length,
        warningCount: response.warnings.length,
      });
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }

    logTraderComparisonComplete(ctx, {
      startedAt,
      status: 200,
      outcome: "success",
      walletCount: queryParse.data.wallet.length,
      traderCount: parsed.data.traders.length,
      warningCount: parsed.data.warnings.length,
    });
    return NextResponse.json(parsed.data);
  }
);

function logTraderComparisonComplete(
  ctx: RequestContext,
  fields: {
    startedAt: number;
    status: number;
    outcome: "success" | "error";
    walletCount: number;
    traderCount: number;
    warningCount: number;
    errorCode?: string | undefined;
  }
): void {
  logEvent(ctx.log, EVENT_NAMES.POLY_RESEARCH_TRADER_COMPARISON_COMPLETE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: fields.status,
    durationMs: Math.round(performance.now() - fields.startedAt),
    outcome: fields.outcome,
    walletCount: fields.walletCount,
    traderCount: fields.traderCount,
    warningCount: fields.warningCount,
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
  });
}
