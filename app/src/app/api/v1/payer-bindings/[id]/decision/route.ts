// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/payer-bindings/[id]/decision`
 * Purpose: An owner of the account turns a pending payer binding On (`{ approve: true }`) or dismisses it (`{ approve: false }`) (story.0038 phase 2).
 * Scope: HTTP validation and delegation to the agent authority. The approver is always the authenticated caller (session or bearer), never a body field.
 * Invariants:
 *   - OWNERS_DECIDE: the one gate is `canApprove` for the binding's account; an org's owners come from its owner source at decision time, and a failed owner read is 503, never a yes.
 *   - NO_SELF_APPROVAL: the subject deciding its own binding is 403 `self_approval`.
 *   - NON_DISCLOSING: an unknown, closed or already-decided binding is `changed: false`.
 * Side-effects: IO (service-role database write, owner source read), logs `payer.bound` / `payer.revoked`
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { payerBindingDecisionOperation } from "@cogni/node-contracts";
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

export const POST = wrapRouteHandlerWithLogging<{ params: Promise<{ id: string }> }>(
  {
    routeId: "payer-bindings.decision",
    bearerWrite: "an owner of the account turns a payer binding on it On or dismisses it; the decision passes canApprove for that account (an org's owners come from its owner source), never the caller's own data",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser, context) => {
    if (!sessionUser) return json({ error: "unauthorized" }, 401);
    if (!context) throw new Error("context required for dynamic routes");
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) return json({ error: "not_found" }, 404);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = payerBindingDecisionOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const result = await getContainer().agentAuthority.decidePayerBinding(
        { userId: sessionUser.id, admin: null },
        id,
        parsed.data.approve
      );
      return json(payerBindingDecisionOperation.output.parse(result));
    } catch (error) {
      if (error instanceof AgentRolesError && (error.code === "self_approval" || error.code === "not_allowed"))
        return json({ error: error.code }, 403);
      // Anything else, including an owner source that could not be read, refuses: never a yes.
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "payer-bindings.decision", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
