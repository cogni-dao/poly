// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/work/items/[id]/route`
 * Purpose: HTTP endpoints for a single Dolt-backed work item.
 * Scope: Auth-protected GET, PATCH, and DELETE endpoints.
 * Invariants: VALIDATE_IO, CONTRACTS_ARE_TRUTH
 * Write errors (task.0097, bug.0063): the package route core `handleWorkItemPatch` answers every write-contract error and emits the one terminal work.items.patch_* event; this route keeps only auth, 403, 404 and backend-unavailable.
 * Reason + cites (task.0086): a missing or over-cap reason is HTTP400 `invalid input` with an issue at `reason`; an unknown cite id or a closed inbox is HTTP400 `cite_unresolved`; cites with no resolver wired is HTTP400 `cites_unsupported`; a resolver failure is HTTP503. Nothing is written in each case.
 * Moves (story.0033): `set.moves` with an unknown or deprecated metric id is HTTP400 `cite_unresolved` with an issue at `set.moves`; a bad list is HTTP400 `invalid input`; a non-empty list with no metric wiring is HTTP400 `moves_unsupported`; a resolver failure is HTTP503 `cite_resolver_unavailable`; a baseline failure is HTTP503 `metric_baseline_unavailable`. The client never sets a baseline: the server pins it.
 * Read core (story.0085): `handleWorkItemGet` from @cogni/work-items parses `include` (links, artifacts, history) and `artifact`, refuses 400/404/503/499 and returns the one terminal event; this route keeps only auth and the store read. Each `moves` entry carries its metric, KPI and goal (task.0118).
 * Side-effects: IO (HTTP response, Doltgres read/write via port)
 * Links: contracts/work.items.{get,patch,delete}.v1.contract
 * @public
 */

import {
  workItemsGetOperation,
  workItemsPatchOperation,
} from "@cogni/node-contracts";
import {
  handleWorkItemGet,
  handleWorkItemPatch,
  routeAttribution,
} from "@cogni/work-items";
import { NextResponse } from "next/server";
import {
  getWorkItem,
  patchWorkItem,
  WorkItemForbiddenError,
  WorkItemNotFoundError,
} from "@/app/_facades/work/items.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/work/items/:id — Get a single work item by ID.
 */
export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  { routeId: "work.items.get", auth: { mode: "required", getSessionUser } },
  async (ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    // The package owns the `include`/`artifact` parse, the 400/404/503/499 refusals and the one terminal event (story.0085).
    const result = await handleWorkItemGet(id, {
      searchParams: new URL(request.url).searchParams,
      signal: request.signal,
      read: (itemId, options) =>
        getWorkItem(itemId, { signal: request.signal, ...options }),
      toBody: (item) => workItemsGetOperation.output.parse(item),
    });
    ctx.log.info(result.event, result.event.event);
    return NextResponse.json(result.body, { status: result.status });
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
    const attribution = routeAttribution(sessionUser.id);
    // The package owns parse, refusals and the one terminal event (bug.0063); this route keeps auth, the actor and node errors.
    const result = await handleWorkItemPatch(id, {
      readJson: () => request.json(),
      parse: (body) => workItemsPatchOperation.input.safeParse(body),
      write: (input) =>
        patchWorkItem(input, { id: sessionUser.id }, attribution),
      attribution,
      toBody: (patched) => workItemsPatchOperation.output.parse(patched),
      mapNodeError: (e) => {
        if (e instanceof WorkItemNotFoundError)
          return {
            status: 404,
            errorCode: "not_found",
            body: { error: e.message },
          };
        if (e instanceof WorkItemForbiddenError)
          return {
            status: 403,
            errorCode: "forbidden",
            body: { error: e.message },
          };
        return undefined;
      },
    });
    ctx.log.info(result.event, result.event.event);
    return NextResponse.json(result.body, { status: result.status });
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
    logEvent(ctx.log, EVENT_NAMES.WORK_ITEMS_DELETE_RETIRED, {
      reqId: ctx.reqId, routeId: "work.items.delete", status: 410,
      outcome: "refused", errorCode: "gone",
    });
    return NextResponse.json({
      error: "gone",
      message: "Deletion is retired. Read the current revision, then PATCH with reason, expectedRevision and set.status=cancelled; history and artifacts are preserved.",
    }, { status: 410 });
  }
);
