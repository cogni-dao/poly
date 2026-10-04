// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/agent-grants`
 * Purpose: Owner-scoped GET/POST lifecycle for principal capability grants.
 * Scope: Auth, contract validation, facade delegation, and HTTP mapping only.
 * Invariants: browser-session-only owner lifecycle; tenant identity is always
 *   derived from auth, never trusted from the request body.
 * Side-effects: IO through the facade.
 * @public
 */

import {
  polyAgentGrantsCreateOperation,
  polyAgentGrantsErrorOutput,
  polyAgentGrantsListOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";

import {
  AgentGrantFacadeError,
  createAgentGrantFacade,
  listAgentGrantsFacade,
} from "@/app/_facades/poly/agent-grants.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(
  error: "invalid_request" | "not_found" | "conflict",
  status: number
) {
  return NextResponse.json(polyAgentGrantsErrorOutput.parse({ error }), {
    status,
  });
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.agent_grants.list",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, _request, sessionUser) => {
    const result = await listAgentGrantsFacade(sessionUser);
    return NextResponse.json(polyAgentGrantsListOperation.output.parse(result));
  }
);

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.agent_grants.create",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("invalid_request", 400);
    }

    const parsed = polyAgentGrantsCreateOperation.input.safeParse(body);
    if (!parsed.success) return errorResponse("invalid_request", 422);

    try {
      const result = await createAgentGrantFacade(
        sessionUser,
        parsed.data,
        ctx.log
      );
      return NextResponse.json(
        polyAgentGrantsCreateOperation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof AgentGrantFacadeError) {
        const status =
          error.code === "not_found"
            ? 404
            : error.code === "conflict"
              ? 409
              : 422;
        return errorResponse(error.code, status);
      }
      throw error;
    }
  }
);
