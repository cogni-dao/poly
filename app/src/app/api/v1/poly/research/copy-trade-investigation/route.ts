// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Bounded saved-facts snapshot for one authorized account/condition pair.
 * Owner and delegated bearer principals share the same identity and response path.
 */

import { withTenantScope } from "@cogni/db-client";
import { toUserId, userActor } from "@cogni/ids";
import {
  PolyResearchCopyTradeInvestigationQuerySchema,
  PolyResearchCopyTradeInvestigationResponseSchema,
} from "@cogni/poly-node-contracts";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  type PerformanceReadAccess,
  resolvePerformanceRead,
} from "@/features/agent-grants/authorization";
import { getCopyTradeInvestigationSummary } from "@/features/wallet-analysis/server/copy-trade-investigation-service";
import { EVENT_NAMES, logEvent, type RequestContext } from "@/shared/observability";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research-copy-trade-investigation",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    if (!sessionUser) throw new Error("sessionUser required");
    const url = new URL(request.url);
    const parsedQuery = PolyResearchCopyTradeInvestigationQuerySchema.safeParse({
      billing_account_id: url.searchParams.get("billing_account_id") ?? "",
      condition_id: url.searchParams.get("condition_id") ?? "",
      mode: url.searchParams.get("mode") ?? undefined,
      since: url.searchParams.get("since") ?? undefined,
      until: url.searchParams.get("until") ?? undefined,
    });
    if (!parsedQuery.success) {
      logComplete(ctx, startedAt, {
        status: 400,
        outcome: "error",
        authorizationOutcome: "not_evaluated",
        errorCode: "invalid_query",
        evidenceCount: 0,
      });
      return NextResponse.json(
        { error: "invalid_query", message: parsedQuery.error.message },
        { status: 400 }
      );
    }

    const actorId = userActor(toUserId(sessionUser.id));
    let authorized: {
      access: PerformanceReadAccess;
      response: Awaited<ReturnType<typeof getCopyTradeInvestigationSummary>>;
    } | null;
    try {
      authorized = await withTenantScope(resolveAppDb(), actorId, async (tx) => {
        await tx.execute(
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
        );
        const access = await resolvePerformanceRead(tx, {
          principalId: sessionUser.id,
          billingAccountId: parsedQuery.data.billing_account_id,
        });
        logEvent(ctx.log, EVENT_NAMES.POLY_AGENT_GRANT_ACCESS_DECISION, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          outcome: access ? "allow" : "deny",
          requiredScope: "performance:read",
          ...(access ? { accessKind: access.accessKind } : {}),
        });
        if (!access) return null;
        const response = await getCopyTradeInvestigationSummary(
          tx as unknown as Parameters<typeof getCopyTradeInvestigationSummary>[0],
          parsedQuery.data
        );
        return { access, response };
      });
    } catch {
      logComplete(ctx, startedAt, {
        status: 500,
        outcome: "error",
        authorizationOutcome: "not_evaluated",
        errorCode: "service_failed",
        evidenceCount: 0,
      });
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    if (!authorized || !authorized.response) {
      logComplete(ctx, startedAt, {
        status: 404,
        outcome: "error",
        authorizationOutcome: authorized ? "allowed" : "denied",
        accessKind: authorized?.access.accessKind,
        errorCode: "not_found",
        evidenceCount: 0,
      });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const response = PolyResearchCopyTradeInvestigationResponseSchema.safeParse(
      authorized.response
    );
    if (!response.success) {
      logComplete(ctx, startedAt, {
        status: 500,
        outcome: "error",
        authorizationOutcome: "allowed",
        accessKind: authorized.access.accessKind,
        errorCode: "response_validation_failed",
        evidenceCount: 0,
      });
      return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }

    const evidenceCount =
      response.data.aggregates.fills.count + response.data.aggregates.decisions.count;
    logComplete(ctx, startedAt, {
      status: 200,
      outcome: "success",
      authorizationOutcome: "allowed",
      accessKind: authorized.access.accessKind,
      evidenceCount,
      complete: response.data.completeness.complete,
    });
    return NextResponse.json(response.data);
  }
);

function logComplete(
  ctx: RequestContext,
  startedAt: number,
  fields: {
    status: number;
    outcome: "success" | "error";
    authorizationOutcome: "not_evaluated" | "allowed" | "denied";
    accessKind?: PerformanceReadAccess["accessKind"] | undefined;
    errorCode?: string | undefined;
    evidenceCount: number;
    complete?: boolean | undefined;
  }
): void {
  logEvent(ctx.log, EVENT_NAMES.POLY_RESEARCH_COPY_TRADE_INVESTIGATION_COMPLETE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: fields.status,
    durationMs: Math.round(performance.now() - startedAt),
    outcome: fields.outcome,
    authorizationOutcome: fields.authorizationOutcome,
    ...(fields.accessKind ? { accessKind: fields.accessKind } : {}),
    ...(fields.errorCode ? { errorCode: fields.errorCode } : {}),
    evidenceCount: fields.evidenceCount,
    ...(fields.complete !== undefined ? { complete: fields.complete } : {}),
  });
}
