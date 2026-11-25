// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/public/agent/service-enrollments`
 * Purpose: A service on a trusted home node asks this node for one permission (story.0038). The ask is signed: `Authorization: Bearer <assertion>` and body `{ scope }`.
 *   X (this node) verifies the assertion against the home's published keys, creates or reuses ONE principal per (issuer, service), and writes ONE pending ask.
 * Scope: HTTP validation, the assertion check and delegation to the agent authority. No authority logic, no session (the public wrapper, `auth.mode: none`: the assertion is the credential).
 * Invariants:
 *   - NOTHING_IS_GRANTED: the answer is `pending` (201 when the ask is new, 200 when it already waited) or `granted` (200, a live grant exists). An admin turns the ask On in
 *     `/admin/ai-access`; this route never writes an approver.
 *   - FAIL_CLOSED: an unreadable, untrusted, expired, replayed or unlisted-service assertion is 401; an unreachable key set is 503; a scope outside the signed assertion is 400.
 *   - NO_TOKEN_IN_LOGS: `service_auth.verified` / `service_auth.rejected` carry issuer, service and code, never the token.
 * Side-effects: IO (service-role database write, home JWKS fetch)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { serviceEnrollmentOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapPublicRoute } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trimStart() || null;
}

// wrapPublicRoute: rate limited per IP, no session (the signed assertion is the credential). A POST answer is never cached.
export const POST = wrapPublicRoute(
  { routeId: "agent.service-enrollment.create", cacheTtlSeconds: 0, staleWhileRevalidateSeconds: 0 },
  async (ctx, request) => {
    const token = bearerOf(request);
    if (!token) return json({ error: "invalid_token" }, 401);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = serviceEnrollmentOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);

    const container = getContainer();
    try {
      const assertion = await container.serviceAuth.verify(token);
      if (!assertion.ok) {
        if (assertion.code === "jwks_unavailable") return json({ error: "authz_unavailable" }, 503);
        return json({ error: "invalid_token" }, 401);
      }
      const outcome = await container.agentAuthority.requestServiceAccess(assertion, parsed.data.scope);
      return json(
        serviceEnrollmentOperation.output.parse({ status: outcome.state }),
        outcome.created ? 201 : 200
      );
    } catch (error) {
      if (error instanceof AgentRolesError) {
        if (error.code === "invalid_scope") return json({ error: "invalid_scope" }, 400);
        if (error.code === "no_external_door") return json({ error: "no_external_door" }, 400);
        if (error.code === "too_many_requests") return json({ error: "too_many_requests" }, 429);
      }
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "agent.service-enrollment.create", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
