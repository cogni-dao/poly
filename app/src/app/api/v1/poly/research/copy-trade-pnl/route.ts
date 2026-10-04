// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/research/copy-trade-pnl/route`
 * Purpose: HTTP GET for the per-tenant copy-trade execution rollup that powers the trust-twin diff.
 *   Compares preview paper vs PROD live PnL on the same target wallet config.
 * Scope: Thin handler; does not aggregate in JS, write rows, or fan out upstream.
 *   Human sessions and machine bearers use the same principal contract. Tenant id
 *   remains explicit, but the principal must own the account or hold an active
 *   `performance:read` grant. The aggregate runs under app-role RLS.
 * Invariants: SQL_AGGREGATION_ONLY — service is one GROUP BY, no V8 hydration;
 *   TENANT_PARAM_EXPLICIT — `billing_account_id` is required;
 *   CAPABILITY_GATED — every denial returns the same non-disclosing 404 response;
 *   PAGE_LOAD_DB_ONLY — no upstream calls on render path.
 * Side-effects: IO (DB reads via the feature service).
 * Links: nodes/poly/packages/node-contracts/src/poly.research-copy-trade-pnl.v1.contract.ts
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import {
  PolyResearchCopyTradePnlQuerySchema,
  PolyResearchCopyTradePnlResponseSchema,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  type PerformanceReadAccess,
  resolvePerformanceRead,
} from "@/features/agent-grants/authorization";
import { getCopyTradePnlForTenant } from "@/features/wallet-analysis/server/copy-trade-pnl-service";
import {
  EVENT_NAMES,
  logEvent,
  type RequestContext,
} from "@/shared/observability";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research-copy-trade-pnl",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");
    const url = new URL(request.url);
    const queryParse = PolyResearchCopyTradePnlQuerySchema.safeParse({
      billing_account_id: url.searchParams.get("billing_account_id") ?? "",
      mode: url.searchParams.get("mode") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      until: url.searchParams.get("until") ?? undefined,
    });
    if (!queryParse.success) {
      logComplete(ctx, {
        startedAt,
        status: 400,
        outcome: "error",
        authorizationOutcome: "not_evaluated",
        errorCode: "invalid_query",
        marketsCount: 0,
        fillsCount: 0,
      });
      return NextResponse.json(
        { error: "invalid_query", message: queryParse.error.message },
        { status: 400 }
      );
    }

    const db = resolveAppDb();
    const actorId = userActor(toUserId(sessionUser.id));

    let authorizedResult: {
      access: PerformanceReadAccess;
      response: Awaited<ReturnType<typeof getCopyTradePnlForTenant>>;
    } | null;
    try {
      authorizedResult = await withTenantScope(db, actorId, async (tx) => {
        const access = await resolvePerformanceRead(tx, {
          principalId: sessionUser.id,
          billingAccountId: queryParse.data.billing_account_id,
        });
        logEvent(ctx.log, EVENT_NAMES.POLY_AGENT_GRANT_ACCESS_DECISION, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: access ? "allow" : "deny",
          requiredScope: "performance:read",
          principalId: sessionUser.id,
          billingAccountId: queryParse.data.billing_account_id,
          ...(access
            ? {
                accessKind: access.accessKind,
                ...(access.grantId ? { grantId: access.grantId } : {}),
              }
            : {}),
        });
        if (!access) return null;

        const pnlDb =
          tx as unknown as Parameters<typeof getCopyTradePnlForTenant>[0];
        const response = await getCopyTradePnlForTenant(
          pnlDb,
          queryParse.data.billing_account_id,
          queryParse.data.mode,
          {
            ...(queryParse.data.since !== undefined
              ? { since: queryParse.data.since }
              : {}),
            ...(queryParse.data.until !== undefined
              ? { until: queryParse.data.until }
              : {}),
          }
        );
        return { access, response };
      });
    } catch {
      logComplete(ctx, {
        startedAt,
        status: 500,
        outcome: "error",
        authorizationOutcome: "not_evaluated",
        errorCode: "service_failed",
        marketsCount: 0,
        fillsCount: 0,
      });
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }

    if (!authorizedResult) {
      logComplete(ctx, {
        startedAt,
        status: 404,
        outcome: "error",
        authorizationOutcome: "denied",
        errorCode: "not_found",
        marketsCount: 0,
        fillsCount: 0,
      });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const { access, response } = authorizedResult;

    const parsed = PolyResearchCopyTradePnlResponseSchema.safeParse(response);
    if (!parsed.success) {
      logComplete(ctx, {
        startedAt,
        status: 500,
        outcome: "error",
        authorizationOutcome: "allowed",
        accessKind: access.accessKind,
        errorCode: "response_validation_failed",
        marketsCount: response.markets.length,
        fillsCount: response.summary.fills_count,
      });
      return NextResponse.json(
        { error: "Internal server error" },
        { status: 500 }
      );
    }

    logComplete(ctx, {
      startedAt,
      status: 200,
      outcome: "success",
      authorizationOutcome: "allowed",
      accessKind: access.accessKind,
      marketsCount: parsed.data.markets.length,
      fillsCount: parsed.data.summary.fills_count,
    });
    return NextResponse.json(parsed.data);
  }
);

function logComplete(
  ctx: RequestContext,
  fields: {
    startedAt: number;
    status: number;
    outcome: "success" | "error";
    authorizationOutcome: "not_evaluated" | "allowed" | "denied";
    accessKind?: PerformanceReadAccess["accessKind"] | undefined;
    marketsCount: number;
    fillsCount: number;
    errorCode?: string | undefined;
  }
): void {
  logEvent(ctx.log, EVENT_NAMES.POLY_RESEARCH_COPY_TRADE_PNL_COMPLETE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: fields.status,
    durationMs: Math.round(performance.now() - fields.startedAt),
    outcome: fields.outcome,
    authorizationOutcome: fields.authorizationOutcome,
    ...(fields.accessKind ? { accessKind: fields.accessKind } : {}),
    marketsCount: fields.marketsCount,
    fillsCount: fields.fillsCount,
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
  });
}
