// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent-access/mine/preview`
 * Purpose: HUMAN plane, session only. A signed-in person who opened an AI's one-time link on `/profile` sends its token (read from the URL fragment) and
 *   gets back the waiting account ask as a table row, so the page shows and highlights it.
 * Scope: HTTP validation and the session read. Looks the ask up; decides nothing and writes nothing.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required` before anything is read.
 *   - NON_DISCLOSING: a wrong-kind (a node token), used, expired or unknown token is ONE answer: 404 `not_found`.
 *   - TOKEN_IN_BODY_ONLY: the token is POSTed; the response carries no token.
 * Side-effects: IO (service-role database read)
 * Links: packages/agent-grants (previewAsk)
 * @public
 */

import { agentPreviewOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.mine.preview", auth: { mode: "none" } },
  async (ctx, request) => {
    const refused = refuseNonSession(request, ctx.log);
    if (refused) return refused;
    const user = await getSessionUser();
    if (!user || user.via !== "session") return json({ error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = agentPreviewOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "not_found" }, 404);
    try {
      const permission = await getContainer().agentAuthority.previewAsk({ token: parsed.data.token, resource: "account" });
      if (!permission) return json({ error: "not_found" }, 404);
      return json(agentPreviewOperation.output.parse({ permission }));
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "agent.mine.preview", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
