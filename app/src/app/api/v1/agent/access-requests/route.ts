// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests`
 * Purpose: AI plane (bearer only). One door where an agent asks for access for itself (POST) and lists its own asks (GET).
 *   Two kinds of ask share this path, told apart by the body: `{ scope }` asks for a node permission (the grant path of
 *   `@cogni/agent-grants`: an OFF row an admin turns on in /admin/ai-access); `{ expires_at }` asks the signed-in owner for
 *   account-read access (poly's owner-approval flow, unchanged).
 * Scope: HTTP validation, the bearer-only plane rule, and delegation to the agent authority or the account-read facade.
 *   No authority logic.
 * Invariants:
 *   - KIND_PICKS_THE_PLANE: a browser session (or a request with no machine credential) gets 404, never a result. Token
 *     verification stays in the request-identity resolver; a bad bearer never falls back to a cookie. The node-permission ask
 *     needs a verified bearer identity (`via`); the account-read ask also needs the machine credential header.
 *   - SELF_REQUEST_ONLY: the caller's own user id is the principal and the requester. The body never names another agent.
 *   - NO_SELF_APPROVAL: a node-permission ask writes a row with no approver. It opens no lock. Only an admin session on
 *     /api/v1/admin/ai-access sets an approver.
 *   - The ask door is open by design: any authenticated bearer may ask with no prior grant (OPEN_BY_DESIGN_ROUTES).
 *   - APPROVAL_URL: every answer carries `approvalUrl`, the page of THIS ask. An owned agent asking for a delegable scope (`knowledge:read`, `knowledge:contribute`)
 *     gets its owner's profile page; every other ask gets the Admin page. The origin comes from config, never from the Host header.
 *   - NODE_DECLARED_SCOPES: an undeclared scope is 400 `invalid_scope`; a scope no route an outside agent can call uses is 400
 *     `no_external_door`. Open asks are capped per agent and across the node (429).
 *   - GET returns the node-permission list (`{ requests: [{ scope, state, at }] }`); `GET ?kind=account` returns the
 *     account-read request list (the shape this route returned before the node-permission ask existed).
 * Side-effects: IO (service-role database write and read; account-read facade)
 * Links: packages/agent-grants, https://cognidao.org/knowledge/ai-access-surface-design
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import {
  agentAccessRequestCreateOperation,
  agentAccessRequestListOperation,
} from "@cogni/node-contracts";
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
import { configuredUrl } from "@/app/_lib/agent-access/setup-line";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

import { isAgentBearerRequest } from "./_bearer-transport";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

function accountErrorResponse(
  error: "invalid_request" | "not_found" | "conflict",
  status: number
) {
  return NextResponse.json(agentAccessRequestErrorOutput.parse({ error }), {
    status,
  });
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access.requests.create",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    // AI plane: a bearer only. A browser session gets 404, as if the route did not exist for it.
    const viaBearer = sessionUser.via === "bearer";
    const headerBearer = isAgentBearerRequest(request);
    if (!viaBearer && !headerBearer) return json({ error: "not_found" }, 404);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }

    // Account-read ask (poly's owner-approval flow): the body carries `expires_at`, never `scope`.
    if (
      typeof body === "object" &&
      body !== null &&
      "expires_at" in body &&
      !("scope" in body)
    ) {
      if (!headerBearer) return accountErrorResponse("not_found", 404);
      const parsedAccount =
        polyAgentAccessRequestCreateOperation.input.safeParse(body);
      if (!parsedAccount.success)
        return accountErrorResponse("invalid_request", 422);
      try {
        const result = await createAgentAccessRequestFacade(
          sessionUser,
          parsedAccount.data,
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
          return accountErrorResponse(error.code, status);
        }
        throw error;
      }
    }

    if (!viaBearer) return json({ error: "not_found" }, 404);
    const parsed = agentAccessRequestCreateOperation.input.safeParse(body);
    if (!parsed.success)
      return json({ error: "invalid input", issues: parsed.error.issues }, 400);

    try {
      const result = await getContainer().agentAuthority.requestAccess({
        principalUserId: sessionUser.id,
        scope: parsed.data.scope,
      });
      const { approvalPath, ...answer } = result;
      return json(
        agentAccessRequestCreateOperation.output.parse({
          scope: parsed.data.scope,
          ...answer,
          approvalUrl: approvalPath ? configuredUrl(approvalPath) : null,
        }),
        result.created ? 201 : 200
      );
    } catch (error) {
      if (error instanceof AgentRolesError) {
        if (error.code === "invalid_scope")
          return json({ error: "invalid_scope" }, 400);
        if (error.code === "no_external_door")
          return json({ error: "no_external_door" }, 400);
        if (error.code === "too_many_requests")
          return json({ error: "too_many_requests" }, 429);
      }
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "agent.access.requests.list",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    const viaBearer = sessionUser.via === "bearer";
    const headerBearer = isAgentBearerRequest(request);
    if (!viaBearer && !headerBearer) return json({ error: "not_found" }, 404);

    const searchParams = new URL(request.url).searchParams;
    if (searchParams.get("kind") === "account") {
      if (!headerBearer) return accountErrorResponse("not_found", 404);
      searchParams.delete("kind");
      const parsedAccount =
        polyAgentAccessRequestAgentListOperation.input.safeParse(
          Object.fromEntries(searchParams.entries())
        );
      if (!parsedAccount.success)
        return accountErrorResponse("invalid_request", 422);
      const result = await listAgentAccessRequestsFacade(sessionUser);
      return NextResponse.json(
        polyAgentAccessRequestAgentListOperation.output.parse(result)
      );
    }

    if (!viaBearer) return json({ error: "not_found" }, 404);
    try {
      const requests = await getContainer().agentAuthority.listOwnAccess(sessionUser.id);
      return json(
        agentAccessRequestListOperation.output.parse({
          requests: requests.map(({ approvalPath, ...row }) => ({ ...row, ...(approvalPath ? { approvalUrl: configuredUrl(approvalPath) } : {}) })),
        })
      );
    } catch {
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
