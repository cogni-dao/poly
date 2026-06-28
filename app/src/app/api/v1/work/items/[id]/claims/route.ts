// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/claims/route`
 * Purpose: HTTP endpoint for claiming and releasing work items.
 * Scope: Auth-protected POST/DELETE endpoints. Does not contain business logic.
 * Invariants: VALIDATE_IO, PORT_VIA_FACADE
 * Side-effects: IO (HTTP response, filesystem write via port)
 * @public
 */

import { WorkItemDtoSchema } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  claimWorkItem,
  releaseWorkItem,
  WorkItemNotFoundError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ClaimRequestSchema = z.object({
  runId: z.string().min(1),
  command: z.string().min(1),
});

const ReleaseQuerySchema = z.object({
  runId: z.string().min(1),
});

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.claim", auth: { mode: "required", getSessionUser } },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = ClaimRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    try {
      const result = await claimWorkItem({ id, ...parsed.data });
      ctx.log.info(
        { workItemId: id, runId: parsed.data.runId },
        "work.items.claim_success"
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

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.release", auth: { mode: "required", getSessionUser } },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    const url = new URL(request.url);

    const parsed = ReleaseQuerySchema.safeParse({
      runId: url.searchParams.get("runId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    try {
      const result = await releaseWorkItem({ id, runId: parsed.data.runId });
      ctx.log.info(
        { workItemId: id, runId: parsed.data.runId },
        "work.items.release_success"
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
