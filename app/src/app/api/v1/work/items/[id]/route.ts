// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for a single Dolt-backed work item.
 * Scope: Auth-protected GET/PATCH; content DELETE is retired (HTTP 410).
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
  getWorkItem,
  isWorkItemRevisionConflictError,
  patchWorkItem,
  WorkItemForbiddenError,
  WorkItemNotFoundError,
  WorkItemsBackendNotReadyError,
  WorkItemWriteOutcomeUnknownError,
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
    if (
      typeof body === "object" &&
      body !== null &&
      "id" in body &&
      body.id !== undefined &&
      body.id !== id
    ) {
      return NextResponse.json(
        { error: "body id must match path id" },
        { status: 400 }
      );
    }
    const parsed = workItemsPatchOperation.input.safeParse({
      ...(typeof body === "object" && body !== null ? body : {}),
      id,
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
      });
      ctx.log.info({ workItemId: id }, "work.items.patch_success");
      return NextResponse.json(workItemsPatchOperation.output.parse(patched));
    } catch (error) {
      if (error instanceof WorkItemNotFoundError) {
        return NextResponse.json({ error: error.message }, { status: 404 });
      }
      if (error instanceof WorkItemForbiddenError) {
        return NextResponse.json({ error: error.message }, { status: 403 });
      }
      if (isWorkItemRevisionConflictError(error)) {
        return NextResponse.json(
          { error: "revision_conflict", currentRevision: error.currentRevision },
          { status: 409 }
        );
      }
      if (error instanceof WorkItemWriteOutcomeUnknownError) {
        return NextResponse.json(
          { error: error.code, retryable: false, lookup: error.receipt.lookup, message: error.message },
          { status: 409 }
        );
      }
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }
  }
);

/** Retired hard-delete: retain versioned identity and provenance. */
export const DELETE = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
  { routeId: "work.items.delete", auth: { mode: "required", getSessionUser } },
  async (_ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    if (!sessionUser) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await context.params;
    const parsed = workItemsDeleteOperation.input.safeParse({ id });
    if (!parsed.success) return NextResponse.json({ error: "invalid input", issues: parsed.error.issues }, { status: 400 });
    return NextResponse.json(workItemsDeleteOperation.output.parse({ error: "work_item_deletion_retired", message: "PATCH status=cancelled to preserve work-item identity and provenance" }), { status: 410 });
  }
);
