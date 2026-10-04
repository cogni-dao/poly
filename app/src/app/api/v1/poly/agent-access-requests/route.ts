// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/agent-access-requests`
 * Purpose: Browser-session-only owner lifecycle list for agent access.
 * Scope: Session auth, response validation, facade delegation.
 * Side-effects: IO through the facade.
 * @public
 */

import { polyAgentAccessRequestsListOperation } from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";

import { listOwnerAgentAccessRequestsFacade } from "@/app/_facades/poly/agent-access-requests.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.agent_access_requests.list",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, _request, sessionUser) => {
    const result = await listOwnerAgentAccessRequestsFacade(sessionUser);
    return NextResponse.json(
      polyAgentAccessRequestsListOperation.output.parse(result)
    );
  }
);
