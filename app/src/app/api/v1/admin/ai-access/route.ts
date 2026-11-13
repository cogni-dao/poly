// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/ai-access`
 * Purpose: ADMIN area, human plane. A node-admin, signed in, lists this node's AI (GET) and turns a permission On (POST: approve a pending ask,
 *   or grant one of this node's AI) or Off (DELETE: revoke, or `deny: true` to dismiss an ask) by clicking on `/admin/ai-access`.
 * Scope: HTTP validation and the mint. Every handler gets its `AdminSession` from `requireAdminSession()` and calls `NodeAdminPort` with it. No authority logic.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN: the only door for these writes. The old `/api/v1/agent-access/roles` route is gone (404). The AI plane has no twin: an agent asks at `/api/v1/agent/access-requests`; a human admin decides here.
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required` (proxy.ts, then the mint).
 *   - FAIL_CLOSED_WITH_DISTINCTION: non-admin 403 `authz_denied`; no configured admins 503 `authz_unavailable`.
 *   - NODE_DECLARED_SCOPES: an undeclared scope is 400 before any write.
 * Side-effects: IO (service-role database read and write), logs `admin.action` and `agent_role.*`
 * Links: src/app/(admin)/_lib/admin-session.ts, src/ports/node-admin.port.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { AgentRolesError, type PrincipalRef } from "@cogni/agent-grants";
import { agentRolesListOperation, agentRolesOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
/** Every response, errors included, is `no-store`. */
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "admin.ai-access.list", auth: { mode: "none" } },
  async (ctx, request) => {
    const admin = await requireAdminSession(request, "ai_access.list");
    if (!admin.ok) return admin.response;
    try {
      const view = await getContainer().nodeAdminPort.listNodeAi(admin.session);
      return json(agentRolesListOperation.output.parse({ canManage: true, ...view }));
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_LIST_FAILED, routeId: "admin.ai-access.list", errorName: error instanceof Error ? error.name : "unknown" }, EVENT_NAMES.AGENT_ROLES_LIST_FAILED);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);

function writeRoute(routeId: string, action: string, write: "on" | "off") {
  return wrapRouteHandlerWithLogging({ routeId, auth: { mode: "none" } }, async (_ctx, request) => {
    const admin = await requireAdminSession(request, action);
    if (!admin.ok) return admin.response;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = agentRolesOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input", issues: parsed.error.issues }, 400);

    const ref: PrincipalRef =
      parsed.data.principalUserId !== undefined
        ? { principalUserId: parsed.data.principalUserId }
        : { principalSlug: parsed.data.principal as string };
    const target = { ref, scope: parsed.data.scope };
    const port = getContainer().nodeAdminPort;

    try {
      const result =
        write === "on"
          ? await port.turnAiPermissionOn(admin.session, target)
          : parsed.data.deny === true
            ? await port.dismissAiRequest(admin.session, target)
            : await port.turnAiPermissionOff(admin.session, target);
      return json(
        agentRolesOperation.output.parse({
          ...(parsed.data.principal !== undefined ? { principal: parsed.data.principal } : {}),
          scope: parsed.data.scope,
          ...result,
        })
      );
    } catch (error) {
      if (error instanceof AgentRolesError) {
        const status =
          error.code === "principal_not_found"
            ? 404
            : error.code === "not_pending"
              ? 409
              : error.code === "self_approval"
                ? 403
                : 400;
        return json({ error: error.code }, status);
      }
      throw error;
    }
  });
}

/** Turning a permission On: approves a pending ask, or grants one of this node's own AI directly. */
export const POST = writeRoute("admin.ai-access.on", "ai_access.on", "on");

/** Turning a permission Off (revoke), or the x on a pending ask (`deny: true`). */
export const DELETE = writeRoute("admin.ai-access.off", "ai_access.off", "off");
