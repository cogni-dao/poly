// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/history`
 * Purpose: GET a work item's versions, newest first, each with its change reason (story.0023).
 * Scope: Thin route: session check, id, `readWorkItemHistory` from `@cogni/work-items`, one log event, response.
 * Invariants: NOTE_NOT_BODY, ONE_HISTORY_SHAPE, one terminal log event per read (counts only).
 * Side-effects: IO (HTTP response, Doltgres read)
 * Links: @cogni-dao/work-items readWorkItemHistory, hub change-history-design
 * @public
 */

import { readWorkItemHistory } from "@cogni/work-items";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.history", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const startedAt = Date.now();
    const { status, body, log } = await readWorkItemHistory(
      getContainer().doltgresWorkItems,
      id
    );
    const { event: _event, errorName, ...fields } = log;
    logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_HISTORY_READ, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      ...fields,
      durationMs: Date.now() - startedAt,
    });
    if (errorName !== undefined) {
      ctx.log.warn({ errorName }, "work.items.history_unavailable");
    }
    return NextResponse.json(body, { status });
  }
);
