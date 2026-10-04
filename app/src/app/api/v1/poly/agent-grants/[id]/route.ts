// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/agent-grants/[id]`
 * Purpose: Owner-scoped soft revocation for one capability grant.
 * Scope: Auth, contract validation, facade delegation, and HTTP mapping only.
 * Invariants: DELETE never removes audit history and does not disclose grants
 *   owned by another account.
 * Side-effects: IO through the facade.
 * @public
 */

import {
  polyAgentGrantRevokeOperation,
  polyAgentGrantsErrorOutput,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";

import {
  AgentGrantFacadeError,
  revokeAgentGrantFacade,
} from "@/app/_facades/poly/agent-grants.server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const DELETE = wrapRouteHandlerWithLogging<{
  params: Promise<{ id: string }>;
}>(
  {
    routeId: "poly.agent_grants.revoke",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const parsed = polyAgentGrantRevokeOperation.input.safeParse(
      await context.params
    );
    if (!parsed.success) {
      return NextResponse.json(
        polyAgentGrantsErrorOutput.parse({ error: "invalid_request" }),
        { status: 400 }
      );
    }

    try {
      const result = await revokeAgentGrantFacade(
        sessionUser,
        parsed.data.id,
        ctx.log
      );
      return NextResponse.json(
        polyAgentGrantRevokeOperation.output.parse(result)
      );
    } catch (error) {
      if (error instanceof AgentGrantFacadeError) {
        return NextResponse.json(
          polyAgentGrantsErrorOutput.parse({ error: error.code }),
          { status: error.code === "not_found" ? 404 : 422 }
        );
      }
      throw error;
    }
  }
);
