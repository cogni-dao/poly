// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/service-links/ask`
 * Purpose: A node admin has this node's AI ask a configured remote node for one permission (story.0038 phase 2): `{ alias, scope }` signs a service assertion as service
 *   `node-ai` and posts it to the target's `/api/v1/public/agent/service-enrollments`. The target's admin turns the ask On there.
 * Scope: HTTP validation, the one admin check, and delegation to `container.serviceLinks.ask`. The alias names an entry of the deployment's `.cogni/service-links.yaml` targets; it is never a URL.
 * Invariants:
 *   - ONE_ADMIN_CHECK: only a node admin (`agentAuthority.adminCheck`, the caller's bound wallets against the repo-spec roster) may start the ask, for a session or a bearer alike.
 *   - NOTHING_IS_GRANTED: the answer is the target's `pending` or `granted` (or its refusal status); nothing is written on either node's grant table here.
 *   - FAIL_CLOSED: an unknown alias is 404 `unknown_alias`; no signing key is 503 `signer_unavailable`; an unreachable target is 502 `target_unreachable`.
 *   - NO_TOKEN_IN_LOGS: `service_link.asked` carries alias, scope and status only.
 * Side-effects: IO (one signed HTTPS POST to a configured node)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { serviceLinkAskOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "service-links.ask",
    bearerWrite: "node-admin only through the one admin check, for any credential; it signs and posts one ask to a configured node and changes none of the caller's data",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser) => {
    if (!sessionUser) return json({ error: "unauthorized" }, 401);
    const container = getContainer();
    const admin = await container.agentAuthority.adminCheck(sessionUser.id).catch(() => "unavailable" as const);
    if (admin === "unavailable") return json({ error: "authz_unavailable" }, 503);
    if (admin !== "allow") return json({ error: "authz_denied" }, 403);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = serviceLinkAskOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);

    const result = await container.serviceLinks.ask(parsed.data.alias, parsed.data.scope);
    if (!result.ok) {
      if (result.reason === "unknown_alias") return json({ error: "unknown_alias" }, 404);
      if (result.reason === "no_signer") return json({ error: "signer_unavailable" }, 503);
      return json({ error: "target_unreachable" }, 502);
    }
    return json(serviceLinkAskOperation.output.parse({ alias: result.alias, status: result.status, httpStatus: result.httpStatus }));
  }
);
