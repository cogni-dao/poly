// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/agent-access-requests/preview`
 * Purpose: Browser-session-only preview of one pending approval token.
 * Scope: Contract validation and facade delegation; token stays in POST body.
 * Invariants: invalid, expired, and consumed tokens share one 404 response.
 * Side-effects: IO through the facade.
 * @public
 */

import {
  agentAccessRequestErrorOutput,
  polyAgentAccessRequestPreviewOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";

import {
  AgentAccessRequestFacadeError,
  previewAgentAccessRequestFacade,
} from "@/app/_facades/poly/agent-access-requests.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.agent_access_requests.preview",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        agentAccessRequestErrorOutput.parse({ error: "invalid_request" }),
        { status: 400 }
      );
    }
    const parsed = polyAgentAccessRequestPreviewOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        agentAccessRequestErrorOutput.parse({ error: "invalid_request" }),
        { status: 422 }
      );
    }

    try {
      const result = await previewAgentAccessRequestFacade(
        sessionUser,
        parsed.data.approval_token
      );
      return NextResponse.json(
        polyAgentAccessRequestPreviewOperation.output.parse(result)
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
