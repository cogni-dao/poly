// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests/[id]`
 * Purpose: Bearer-only self poll for an agent access request.
 * Scope: Auth transport check, path validation, facade delegation.
 * Invariants: other principals and missing requests are identical 404s.
 * Side-effects: IO through the facade.
 * @public
 */

import {
  agentAccessRequestErrorOutput,
  polyAgentAccessRequestPollOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";

import {
  AgentAccessRequestFacadeError,
  pollAgentAccessRequestFacade,
} from "@/app/_facades/poly/agent-access-requests.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

import { isAgentBearerRequest } from "../_bearer-transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "agent.access_requests.poll",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!isAgentBearerRequest(request)) {
      return NextResponse.json(
        agentAccessRequestErrorOutput.parse({ error: "not_found" }),
        { status: 404 }
      );
    }
    if (!context) throw new Error("context required for dynamic routes");
    const parsed = polyAgentAccessRequestPollOperation.input.safeParse(
      await context.params
    );
    if (!parsed.success) {
      return NextResponse.json(
        agentAccessRequestErrorOutput.parse({ error: "invalid_request" }),
        { status: 400 }
      );
    }

    try {
      const result = await pollAgentAccessRequestFacade(
        sessionUser,
        parsed.data.id
      );
      return NextResponse.json(
        polyAgentAccessRequestPollOperation.output.parse(result)
      );
    } catch (error) {
      if (error instanceof AgentAccessRequestFacadeError) {
        return NextResponse.json(
          agentAccessRequestErrorOutput.parse({ error: error.code }),
          { status: error.code === "not_found" ? 404 : 422 }
        );
      }
      throw error;
    }
  }
);
