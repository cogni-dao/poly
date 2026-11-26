// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/_backend-unavailable`
 * Purpose: The one 503 answer and log line for a busy work-item store, so every route names why (task.0162).
 * Scope: For routes with no terminal event of their own, logs the one `work.items.backend_unavailable` line and answers the package's fixed 503 body (`code` is the busy reason). No reads, no writes.
 * Invariants: the body is the package's `backendUnavailableBody`, never the error text; create, PATCH and GET-by-id get the reason from the package cores; every other work-item route uses this helper.
 * Side-effects: IO (log line)
 * Links: @cogni-dao/work-items backendUnavailableBody
 * @internal
 */

import { backendUnavailableBody, type WorkItemsBusyReason } from "@cogni/work-items";
import { NextResponse } from "next/server";

import { EVENT_NAMES, logEvent } from "@/shared/observability";

/** One `work.items.backend_unavailable` line, then the 503. For routes with no terminal event of their own. */
export function backendUnavailable(
  ctx: {
    readonly log: Parameters<typeof logEvent>[0];
    readonly reqId: string;
    readonly routeId: string;
  },
  reason: WorkItemsBusyReason
): NextResponse {
  logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_BACKEND_UNAVAILABLE, {
    reqId: ctx.reqId,
    routeId: ctx.routeId,
    status: 503,
    outcome: "error",
    errorCode: "backend_unavailable",
    reason,
  });
  return NextResponse.json(backendUnavailableBody(reason), { status: 503 });
}
