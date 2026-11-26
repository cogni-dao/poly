// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/expectations/route`
 * Purpose: GET one work item's EDO expectations and their pinned predictions for the shared item view.
 * Scope: Auth, the item and EDO reads, and the log line. `handleWorkExpectations` from @cogni-dao/metrics/http owns the matching,
 *   the one prediction batch, the page and the terminal event (story.0085).
 * Side-effects: IO (Doltgres reads, metric reads, HTTP response)
 * Links: hub work-item-view-capability
 * @public
 */

import { handleWorkExpectations } from "@cogni-dao/metrics/http";
import { NextResponse } from "next/server";

import { getWorkItem } from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
  { routeId: "work.expectations.get", auth: { mode: "required", getSessionUser } },
  async (ctx, request, user, context) => {
    const started = Date.now();
    const headers = { "Cache-Control": "no-store" };
    if (!context) throw new Error("context required");
    if (!user) {
      logEvent(ctx.log, EVENT_NAMES.WORK_EXPECTATIONS_READ, { reqId: ctx.reqId, routeId: ctx.routeId, status: 401, durationMs: Date.now() - started, outcome: "error", errorCode: "unauthorized" });
      return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
    }
    const { id } = await context.params;
    const container = getContainer();
    const readWorkEdo = container.knowledgeStorePort?.readWorkEdo?.bind(container.knowledgeStorePort);
    const result = await handleWorkExpectations({
      workItemId: id,
      readItem: (signal) => getWorkItem(id, { ...(signal && { signal }), chain: false, artifacts: false }),
      readEdo: readWorkEdo && ((signal) => readWorkEdo(id, signal)),
      predictionBatch: container.goalMetrics?.predictionBatch.bind(container.goalMetrics),
      signal: request.signal,
    }).catch(() => undefined);
    if (!result) {
      logEvent(ctx.log, EVENT_NAMES.WORK_EXPECTATIONS_READ, { reqId: ctx.reqId, routeId: ctx.routeId, status: 503, durationMs: Date.now() - started, outcome: "error", errorCode: "unavailable" });
      return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
    }
    logEvent(ctx.log, EVENT_NAMES.WORK_EXPECTATIONS_READ, { reqId: ctx.reqId, durationMs: Date.now() - started, ...result.event });
    return NextResponse.json(result.body, { status: result.status, headers });
  },
);
