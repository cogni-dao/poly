// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/_lib/ai-access-route`
 * Purpose: The route builder of the admin AI-access table and its preview. The one admin mint decides first; the `@cogni/agent-grants/http` core then runs the
 *   call through the node's admin port with that session bound.
 * Scope: Next-side wiring only. Lives in the Admin route area (ADMIN_ACTS_IN_ADMIN): no file outside it names the admin port or the mint.
 * Side-effects: none at import
 * @internal
 */

import { adminAiAccessHttp } from "@cogni/agent-grants/http";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { httpDeps, readJsonBody, send } from "@/app/_lib/agent-access/respond";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

/** An admin AI-access route: the one admin mint decides first, then the package core runs the call through the node's admin port with that session bound. */
export function adminRoute(routeId: string, action: string, call: "list" | "on" | "off" | "preview", withBody: boolean) {
  return wrapRouteHandlerWithLogging({ routeId, auth: { mode: "none" } }, async (ctx, request) => {
    const admin = await requireAdminSession(request, action);
    if (!admin.ok) return admin.response;
    const port = getContainer().nodeAdminPort;
    return send(
      await adminAiAccessHttp(httpDeps(ctx.log), call, {
        ...(withBody ? { body: await readJsonBody(request) } : {}),
        calls: {
          list: () => port.listNodeAi(admin.session),
          on: (target) => port.turnAiPermissionOn(admin.session, target),
          off: (target) => port.turnAiPermissionOff(admin.session, target),
          dismiss: (target) => port.dismissAiRequest(admin.session, target),
          preview: (token) => port.previewAiRequest(admin.session, token),
        },
      })
    );
  });
}
