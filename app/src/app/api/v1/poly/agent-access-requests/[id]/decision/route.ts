// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/agent-access-requests/[id]/decision`
 * Purpose: Browser-session-only approve/deny transition.
 * Scope: Contract validation, path validation, facade delegation.
 * Invariants: approval and authoritative grant creation commit atomically.
 * Side-effects: IO through the facade.
 * @public
 */

import {
  agentAccessRequestErrorOutput,
  polyAgentAccessRequestDecisionOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  AgentAccessRequestFacadeError,
  decideAgentAccessRequestFacade,
} from "@/app/_facades/poly/agent-access-requests.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const pathSchema = z.object({ id: z.string().uuid() });

export const POST = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "poly.agent_access_requests.decision",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const path = pathSchema.safeParse(await context.params);
    if (!path.success) {
      return NextResponse.json(
        agentAccessRequestErrorOutput.parse({ error: "invalid_request" }),
        { status: 400 }
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        agentAccessRequestErrorOutput.parse({ error: "invalid_request" }),
        { status: 400 }
      );
    }
    const parsed = polyAgentAccessRequestDecisionOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        agentAccessRequestErrorOutput.parse({ error: "invalid_request" }),
        { status: 422 }
      );
    }

    try {
      const result = await decideAgentAccessRequestFacade(
        sessionUser,
        path.data.id,
        parsed.data,
        ctx.log
      );
      return NextResponse.json(
        polyAgentAccessRequestDecisionOperation.output.parse(result)
      );
    } catch (error) {
      if (error instanceof AgentAccessRequestFacadeError) {
        const status =
          error.code === "not_found"
            ? 404
            : error.code === "conflict"
              ? 409
              : 422;
        return NextResponse.json(
          agentAccessRequestErrorOutput.parse({ error: error.code }),
          { status }
        );
      }
      throw error;
    }
  }
);
