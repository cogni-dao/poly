// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for a single Dolt-backed work item.
 * Scope: Auth-protected GET, PATCH, and DELETE endpoints.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH
 * Side-effects: IO (HTTP response, Doltgres read/write via port)
 * Links: contracts/work.items.{get,patch,delete}.v1.contract
 * @public
 */

import {
  workItemsDeleteOperation,
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  deleteWorkItem,
  getWorkItem,
  patchWorkItem,
  WorkItemNotFoundError,
  WorkItemsBackendNotReadyError,
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

    let item: Awaited<ReturnType<typeof getWorkItem>>;
    try {
      item = await getWorkItem(id);
    } catch (error) {
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }

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

export const PATCH = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.patch", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const parsed = workItemsPatchOperation.input.safeParse({
      id,
      ...(typeof body === "object" && body !== null ? body : {}),
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const patched = await patchWorkItem(parsed.data, {
        id: sessionUser.id,
        displayName: sessionUser.displayName,
      });
      ctx.log.info({ workItemId: id }, "work.items.patch_success");
      return NextResponse.json(workItemsPatchOperation.output.parse(patched));
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  }
);

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.delete", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const { id } = await context.params;
    const parsed = workItemsDeleteOperation.input.safeParse({ id });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const deleted = await deleteWorkItem(id, {
        id: sessionUser.id,
        displayName: sessionUser.displayName,
      });
      if (!deleted) {
        return NextResponse.json(
          { error: `Work item not found: ${id}` },
          { status: 404 }
        );
      }
      ctx.log.info({ workItemId: id }, "work.items.delete_success");
      return NextResponse.json(
        workItemsDeleteOperation.output.parse({ id, deleted: true })
      );
    } catch (error) {
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  }
);
