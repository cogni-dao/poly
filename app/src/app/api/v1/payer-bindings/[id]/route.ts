// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/payer-bindings/[id]`
 * Purpose: An owner of the account turns a payer binding Off (story.0038 phase 2): `DELETE` ends a pending or live binding. The subject's next run falls back to its own account.
 * Scope: HTTP validation and delegation to the agent authority. The approver is always the authenticated caller (session or bearer).
 * Invariants:
 *   - OWNERS_DECIDE / NO_SELF_APPROVAL: as the decision route. A failed owner read is 503, never a yes. Off is read from the table on the next run, so it does not wait on any cache.
 *   - NON_DISCLOSING: an unknown or already-closed binding is `changed: false`.
 * Side-effects: IO (service-role database write, owner source read), logs `payer.revoked`
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { payerBindingRevokeOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const DELETE = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
  {
    routeId: "payer-bindings.revoke",
    bearerWrite: "an owner of the account turns a payer binding on it Off; the decision passes canApprove for that account (an org's owners come from its owner source), never the caller's own data",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, _request, sessionUser, context) => {
    if (!sessionUser) return json({ error: "unauthorized" }, 401);
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) return json({ error: "not_found" }, 404);
    try {
      const result = await getContainer().agentAuthority.revokePayerBinding({ userId: sessionUser.id, admin: null }, id);
      return json(payerBindingRevokeOperation.output.parse(result));
    } catch (error) {
      if (error instanceof AgentRolesError && (error.code === "self_approval" || error.code === "not_allowed"))
        return json({ error: error.code }, 403);
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "payer-bindings.revoke", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
