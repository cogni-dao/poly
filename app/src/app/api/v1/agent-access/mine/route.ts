// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent-access/mine`
 * Purpose: A signed-in person's own AIs' permission asks, on their profile ("Your AIs"). GET lists what their AIs ask to do with THEIR data and what is On.
 *   POST turns one On (approves the AI's ask; it ends after 30 days). DELETE turns it Off, or dismisses an ask (`deny: true`).
 * Scope: Session guard, input shaping, ownership check and delegation to the agent authority. NOT under /admin: these are the person's own rows, and no node
 *   permission is listed or changed here.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required` (`requirePersonSession`).
 *   - APPROVER_FOLLOWS_RESOURCE: the person decides for an AI they OWN. Another person's AI, an AI with no owner and an unknown id are the same 404 `not_found`.
 *     The agent never turns itself On (NO_SELF_APPROVAL): there is no agent-plane twin of this route.
 *   - OWNER_SEES_ONLY_OWN: the list is keyed on the session's user id, never on a request field. Personal rows only; node rows are Admin's.
 *   - A scope that is not a personal permission is 400 `invalid_scope`; turning On a scope the AI never asked for is 409 `not_pending`.
 *   - NEVER_CACHED: every response is `no-store`.
 * Side-effects: IO (service-role database read and write), logs `agent_role.*`
 * Links: packages/agent-grants (grantPersonal, revokePersonal), https://cognidao.org/knowledge/node-capability-grants-standard, https://cognidao.org/work/items/task.5465
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { agentMineListOperation, agentMineOperation } from "@cogni/node-contracts";
import type { NextResponse } from "next/server";

import { noStoreJson, requirePersonSession } from "@/app/_lib/auth/person-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** An owner-route failure: a known refusal keeps its code; anything else is a store outage (503), never a 500 or an allow. */
function refusal(error: unknown): NextResponse {
  if (error instanceof AgentRolesError) {
    if (error.code === "principal_not_found") return noStoreJson({ error: "not_found" }, 404);
    if (error.code === "not_pending") return noStoreJson({ error: "not_pending" }, 409);
    if (error.code === "invalid_scope") return noStoreJson({ error: "invalid_scope" }, 400);
    if (error.code === "self_approval") return noStoreJson({ error: "self_approval" }, 403);
  }
  return noStoreJson({ error: "authz_unavailable" }, 503);
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.access.mine.list", auth: { mode: "none" } },
  async (_ctx, request) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    try {
      const permissions = await getContainer().agentAuthority.listYourAis(person.userId);
      return noStoreJson(agentMineListOperation.output.parse({ permissions }));
    } catch (error) {
      return refusal(error);
    }
  }
);

function writeRoute(routeId: string, write: "on" | "off") {
  return wrapRouteHandlerWithLogging({ routeId, auth: { mode: "none" } }, async (_ctx, request) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    const parsed = agentMineOperation.input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: "invalid input" }, 400);
    const { principalUserId, scope, deny } = parsed.data;
    const authority = getContainer().agentAuthority;
    try {
      const changed =
        write === "on"
          ? (await authority.turnPersonalOn({ ownerUserId: person.userId, principalUserId, scope })).created
          : (await authority.turnPersonalOff({ ownerUserId: person.userId, principalUserId, scope, ...(deny === true ? { deny: true } : {}) })).changed;
      return noStoreJson(agentMineOperation.output.parse({ principalUserId, scope, changed }));
    } catch (error) {
      return refusal(error);
    }
  });
}

/** Turn On: approves the AI's ask. */
export const POST = writeRoute("agent.access.mine.on", "on");

/** Turn Off (revoke a live row), or the x on an ask (`deny: true`). */
export const DELETE = writeRoute("agent.access.mine.off", "off");
