// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests`
 * Purpose: Bearer-only agent creation and listing of self-bound access
 *   requests.
 * Scope: Auth transport check, contract validation, facade delegation.
 * Invariants: requester identity comes only from the bearer token.
 * Side-effects: IO through the facade.
 * @public
 */

import {
  agentAccessRequestErrorOutput,
  polyAgentAccessRequestAgentListOperation,
  polyAgentAccessRequestCreateOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";

import {
  AgentAccessRequestFacadeError,
  createAgentAccessRequestFacade,
  listAgentAccessRequestsFacade,
} from "@/app/_facades/poly/agent-access-requests.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

import { isAgentBearerRequest } from "./_bearer-transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(
  error: "invalid_request" | "not_found" | "conflict",
  status: number
) {
  return NextResponse.json(agentAccessRequestErrorOutput.parse({ error }), {
    status,
  });
}

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access_requests.list",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    if (!isAgentBearerRequest(request)) {
      return errorResponse("not_found", 404);
    }

    const parsed = polyAgentAccessRequestAgentListOperation.input.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!parsed.success) return errorResponse("invalid_request", 422);

    const result = await listAgentAccessRequestsFacade(sessionUser);
    return NextResponse.json(
      polyAgentAccessRequestAgentListOperation.output.parse(result)
    );
  }
);

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access_requests.create",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!isAgentBearerRequest(request)) {
      return errorResponse("not_found", 404);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse("invalid_request", 400);
    }
    const parsed = polyAgentAccessRequestCreateOperation.input.safeParse(body);
    if (!parsed.success) return errorResponse("invalid_request", 422);

    try {
      const result = await createAgentAccessRequestFacade(
        sessionUser,
        parsed.data,
        ctx.log
      );
      return NextResponse.json(
        polyAgentAccessRequestCreateOperation.output.parse(result),
        { status: 201 }
      );
    } catch (error) {
      if (error instanceof AgentAccessRequestFacadeError) {
        const status =
          error.code === "conflict"
            ? 409
            : error.code === "not_found"
              ? 404
              : 422;
        return errorResponse(error.code, status);
      }
      throw error;
    }
  }
);
