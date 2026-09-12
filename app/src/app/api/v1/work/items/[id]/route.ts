// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoint for getting and patching a single work item by ID.
 * Scope: Auth-protected GET/PATCH endpoints. Does not contain business logic.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH
 * Side-effects: IO (HTTP response, filesystem read/write via port)
 * Links: contracts/work.items.get.v1.contract, contracts/work.items.patch.v1.contract
 * @public
 */

import {
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  getWorkItem,
  patchWorkItem,
  UnsupportedWorkItemPatchFieldsError,
  WorkItemNotFoundError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items/:id — Get a single work item by ID.
 */
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.get", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    const item = await getWorkItem(id);

    if (!item) {
      return NextResponse.json(
        { error: `Work item not found: ${id}` },
        { status: 404 }
      );
    }

    ctx.log.info({ workItemId: id }, "work.items.get_success");

    return NextResponse.json(workItemsGetOperation.output.parse(item));
  }
);

/**
 * PATCH /api/v1/work/items/:id — Patch a work item by ID.
 */
export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.patch", auth: { mode: "required", getSessionUser } },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = workItemsPatchOperation.input.safeParse({
      ...(body && typeof body === "object" ? body : {}),
      id,
    });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    try {
      const result = await patchWorkItem(parsed.data);

      ctx.log.info({ workItemId: id }, "work.items.patch_success");

      return NextResponse.json(workItemsPatchOperation.output.parse(result));
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof UnsupportedWorkItemPatchFieldsError) {
        return NextResponse.json(
          { error: error.message, fields: error.fields },
          { status: 400 }
        );
      }
      throw error;
    }
  }
);
