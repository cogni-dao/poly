// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/agent-access/routes`
 * Purpose: The route builder of the person's own agent access table (human plane, session only). It resolves who the caller is, then hands the call to its
 *   `@cogni/agent-grants/http` core.
 * Scope: Next-side wiring only. Auth and plane checks stay here; every status and body comes from the core.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header (a bearer agent, an admin with a key) is 403 `human_session_required`, before any read or write.
 *   - A cookie write must originate at this node (same origin), like every other session write.
 * Side-effects: none at import
 * @internal
 */

import {
  type AgentAccessAuthority,
  HUMAN_SESSION_REQUIRED,
  type MineCall,
  mineHttp,
  NO_STORE,
} from "@cogni/agent-grants/http";
import { NextResponse } from "next/server";

import { httpDeps, readJsonBody, send } from "@/app/_lib/agent-access/respond";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

function isPublicOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The person's own table, human plane (session only): a bearer is refused with 403 before any read. */
export function mineRoute(routeId: string, call: MineCall, withBody: boolean) {
  return wrapRouteHandlerWithLogging({ routeId, auth: { mode: "none" } }, async (ctx, request) => {
    if (request.headers.get("authorization")) {
      return NextResponse.json({ error: HUMAN_SESSION_REQUIRED }, { status: 403, headers: NO_STORE });
    }
    if (request.method !== "GET" && !isPublicOrigin(request)) {
      return NextResponse.json({ error: "authz_denied" }, { status: 403, headers: NO_STORE });
    }
    const user = await getServerSessionUser();
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    const authority: AgentAccessAuthority = getContainer().agentAuthority;
    return send(
      await mineHttp(httpDeps(ctx.log), call, {
        me: { userId: user.id, admin: null },
        via: "session",
        ...(withBody ? { body: await readJsonBody(request) } : {}),
        authority,
      })
    );
  });
}
