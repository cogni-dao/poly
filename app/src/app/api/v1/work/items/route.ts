// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/route`
 * Purpose: HTTP endpoints for listing and creating Dolt-backed work items.
 * Scope: Auth-protected GET and POST endpoints. Does not contain business logic.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH
 * Write errors (task.0097): `workItemWriteErrorResponse` from @cogni/work-items answers every write-contract error, `moves` errors included (story.0033); this route keeps only auth, the actor and backend-unavailable. The package route core owns parse, refusals and the terminal work.items.create_* event (bug.0063).
 * Side-effects: IO (HTTP response, Doltgres read/write via port)
 * Links: contracts/work.items.{list,create}.v1.contract
 * @public
 */

import {
  workItemsCreateOperation,
  workItemsListOperation,
} from "@cogni/node-contracts";
import { handleWorkItemCreate } from "@cogni/work-items";
import { NextResponse } from "next/server";
import {
  createWorkItem,
  InvalidCursorError,
  listWorkItems,
  WorkItemsBackendNotReadyError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { routeAttribution } from "@/bootstrap/write-attribution";

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
    // The package owns parse, refusals and the one terminal event (bug.0063); this route keeps auth, the actor and node errors.
    const attribution = routeAttribution(sessionUser.id);
    const result = await handleWorkItemCreate({
      readJson: () => request.json(),
      parse: (body) => workItemsCreateOperation.input.safeParse(body),
      write: (input) => createWorkItem(input, attribution),
      attribution,
      toBody: (created) => workItemsCreateOperation.output.parse(created),
      mapNodeError: (e) => {
        if (e instanceof WorkItemsBackendNotReadyError)
          return {
            status: 503,
            errorCode: "backend_unavailable",
            body: { error: e.message },
          };
        return undefined;
      },
    });
    ctx.log.info(result.event, result.event.event);
    return NextResponse.json(result.body, { status: result.status });
  }
);
