// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/coordination/route`
 * Purpose: HTTP endpoint for reading work-item coordination state.
 * Scope: Auth-protected GET endpoint. Does not contain business logic.
 * Invariants: VALIDATE_IO, PORT_VIA_FACADE
 * Side-effects: IO (HTTP response, filesystem read via port)
 * @public
 */

import { NextResponse } from "next/server";
import {
  getWorkItemCoordination,
  WorkItemNotFoundError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "work.items.coordination",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    try {
      const result = await getWorkItemCoordination(id);
      ctx.log.info({ workItemId: id }, "work.items.coordination_success");
      return NextResponse.json(result);
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      throw error;
    }
  }
);
