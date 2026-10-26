// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded owned run metadata; thread authorization stays in the existing chat API. */
import {
  ScheduleParamsSchema,
  schedulesHistoryOperation,
} from "@cogni/scheduling";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import {
  invalidScheduleRead,
  scheduleReadback,
  scheduleReadError,
  scheduleReadHeaders,
} from "../../readback.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ scheduleId: string }>;
}>(
  { routeId: "schedules.history", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, context) => {
    const startedAt = performance.now();
    if (!context) throw new Error("Route context required");
    const params = ScheduleParamsSchema.safeParse(await context.params);
    const search = new URL(request.url).searchParams;
    const query = schedulesHistoryOperation.input.safeParse({
      limit: search.get("limit") ?? undefined,
      cursor: search.get("cursor") ?? undefined,
    });
    if (!params.success || !query.success)
      return invalidScheduleRead(
        ctx,
        EVENT_NAMES.SCHEDULE_HISTORY_READ,
        startedAt
      );
    try {
      const result = await scheduleReadback().history(
        sessionUser.id,
        params.data.scheduleId,
        {
          limit: query.data.limit,
          ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        }
      );
      const response = schedulesHistoryOperation.output.parse(result);
      logEvent(ctx.log, EVENT_NAMES.SCHEDULE_HISTORY_READ, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        status: 200,
        outcome: "success",
        scheduleId: params.data.scheduleId,
        count: result.runs.length,
        durationMs: performance.now() - startedAt,
      });
      return NextResponse.json(response, { headers: scheduleReadHeaders });
    } catch (error) {
      return scheduleReadError(
        error,
        ctx,
        EVENT_NAMES.SCHEDULE_HISTORY_READ,
        startedAt
      );
    }
  }
);
