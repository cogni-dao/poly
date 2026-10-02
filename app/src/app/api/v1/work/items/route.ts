// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/route`
 * Purpose: HTTP endpoints for listing and creating Dolt-backed work items.
 * Scope: Auth-protected GET and POST endpoints. Does not contain business logic.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH
 * Side-effects: IO (HTTP response, Doltgres read/write via port)
 * Links: contracts/work.items.{list,create}.v1.contract
 * @public
 */

import {
  workItemsCreateOperation,
  workItemsListOperation,
} from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  createWorkItem,
  InvalidCursorError,
  listWorkItems,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items — List work items with optional query filters.
 *
 * Query params: types, statuses (comma-separated), text, projectId, node,
 * limit, cursor
 */
export const GET = wrapRouteHandlerWithLogging(
  { routeId: "work.items.list", auth: { mode: "required", getSessionUser } },
  async (ctx, request) => {
    const url = new URL(request.url);

    const typesParam = url.searchParams.get("types");
    const statusesParam = url.searchParams.get("statuses");
    const textParam = url.searchParams.get("text");
    const actorParam = url.searchParams.get("actor");
    const projectIdParam = url.searchParams.get("projectId");
    const nodeParam = url.searchParams.get("node");
    const limitParam = url.searchParams.get("limit");
    const cursorParam = url.searchParams.get("cursor");

    const input = workItemsListOperation.input.parse({
      types: typesParam ? typesParam.split(",") : undefined,
      statuses: statusesParam ? statusesParam.split(",") : undefined,
      text: textParam ?? undefined,
      actor: actorParam ?? undefined,
      projectId: projectIdParam ?? undefined,
      node: nodeParam
        ? nodeParam.includes(",")
          ? nodeParam.split(",")
          : nodeParam
        : undefined,
      limit: limitParam ? Number(limitParam) : undefined,
      cursor: cursorParam ?? undefined,
    });

    let result: Awaited<ReturnType<typeof listWorkItems>>;
    try {
      result = await listWorkItems(input);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        return NextResponse.json({ error: "invalid cursor" }, { status: 400 });
      }
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      throw error;
    }

    ctx.log.info({ count: result.items.length }, "work.items.list_success");

    return NextResponse.json(workItemsListOperation.output.parse(result));
  }
);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "work.items.create", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parsed = workItemsCreateOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    try {
      const created = await createWorkItem(parsed.data, {
        id: sessionUser.id,
        displayName: sessionUser.displayName,
      });
      ctx.log.info({ workItemId: created.id }, "work.items.create_success");
      return NextResponse.json(workItemsCreateOperation.output.parse(created), {
        status: 201,
      });
    } catch (error) {
      if (error instanceof WorkItemsBackendNotReadyError) {
        return NextResponse.json({ error: error.message }, { status: 503 });
      }
      if ((error as Error)?.name === "WorkItemAlreadyExistsError") {
        return NextResponse.json(
          { error: (error as Error).message },
          { status: 409 }
        );
      }
      throw error;
    }
  }
);
