// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/heartbeat/route`
 * Purpose: HTTP endpoint for refreshing a work-item claim heartbeat.
 * Scope: Auth-protected POST endpoint. Does not contain business logic.
 * Invariants: VALIDATE_IO, PORT_VIA_FACADE
 * Side-effects: IO (HTTP response, filesystem write via port)
 * @public
 */

import { WorkItemDtoSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  heartbeatWorkItem,
  WorkItemNotFoundError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HeartbeatRequestSchema = z.object({
  runId: z.string().min(1),
  command: z.string().min(1).optional(),
});

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.heartbeat", auth: { mode: "required", getSessionUser } },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = HeartbeatRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    try {
      const result = await heartbeatWorkItem({
        id,
        runId: parsed.data.runId,
        ...(parsed.data.command !== undefined && {
          command: parsed.data.command,
        }),
      });
      ctx.log.info(
        { workItemId: id, runId: parsed.data.runId },
        "work.items.heartbeat_success"
      );
      return NextResponse.json(WorkItemDtoSchema.parse(result));
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      throw error;
    }
  }
);
