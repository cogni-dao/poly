// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent-access/mine/requests/[id]`
 * Purpose: The owner's Approve or Deny of ONE ask by its id, from the "Your AIs" block on their profile (`/profile?request=<id>` highlights that row): `POST {decision: "approve" | "deny"}`.
 * Scope: Person session guard, then one atomic write through the agent authority. Opening the profile never approves.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`.
 *   - APPROVER_FOLLOWS_RESOURCE: one request, one approver. Another person's request, a node row (an admin's) and an unknown id are the same 404 `not_found`.
 *   - ATOMIC_DECISION: Approve is one UPDATE that matches this id AND still pending AND this owner AND a delegable scope. A request already decided is 409 `not_pending`.
 *   - NEVER_CACHED: every response is `no-store`.
 * Side-effects: IO (service-role database read and write), logs `agent_role.*`
 * Links: packages/agent-grants (decideAsOwner), https://cognidao.org/work/items/task.5465
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { agentRequestDecisionOperation } from "@cogni/node-contracts";
import type { NextResponse } from "next/server";

import { noStoreJson, requirePersonSession } from "@/app/_lib/auth/person-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function refusal(error: unknown): NextResponse {
  if (error instanceof AgentRolesError) {
    if (error.code === "principal_not_found") return noStoreJson({ error: "not_found" }, 404);
    if (error.code === "not_pending") return noStoreJson({ error: "not_pending" }, 409);
    if (error.code === "invalid_scope") return noStoreJson({ error: "invalid_scope" }, 400);
    if (error.code === "self_approval") return noStoreJson({ error: "self_approval" }, 403);
  }
  return noStoreJson({ error: "authz_unavailable" }, 503);
}

export const POST = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "agent.access.mine.request.decide", auth: { mode: "none" } },
  async (_ctx, request, _user, context) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    if (!context) throw new Error("route_context_missing");
    const parsed = agentRequestDecisionOperation.input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: "invalid input" }, 400);
    const { id } = await context.params;
    try {
      const result = await getContainer().agentAuthority.decideOwnerRequest({
        ownerUserId: person.userId,
        requestId: id,
        decision: parsed.data.decision,
      });
      return noStoreJson(agentRequestDecisionOperation.output.parse({ requestId: id, decision: parsed.data.decision, changed: result.changed }));
    } catch (error) {
      return refusal(error);
    }
  }
);
