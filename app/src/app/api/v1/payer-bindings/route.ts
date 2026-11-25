// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/payer-bindings`
 * Purpose: A caller asks to be billed to an account (story.0038 phase 2): `{ billingAccountId }` returns the pending binding's id. The caller is the SUBJECT: any
 *   authenticated principal, a person, an agent or a service principal made from another node's signed assertion.
 * Scope: HTTP validation and delegation to the agent authority (`requestPayerBinding` in `@cogni-dao/agent-grants`). The subject is always the authenticated caller, never a body field.
 * Invariants:
 *   - PAYER_IS_AUTHORIZED: the ask grants nothing. A run bills the account only after an owner of that account approves (`POST /api/v1/payer-bindings/{id}/decision`).
 *   - One open binding per subject: the same account again returns the same row; another account replaces a pending ask, and is 409 `already_bound` while a live binding exists. An account holds
 *     at most 20 pending asks (429 `too_many_requests`); a pending ask ends after 7 days.
 *   - ONE_ANSWER: a new ask, a repeat ask and an ask for an unknown account are all 201 `{ id, status: "pending" }`. KNOWN LEAK: an existing account that already holds 20 pending asks answers 429,
 *     which tells a caller the account exists and is full; an unknown account never does.
 *   - UNKNOWN_ACCOUNT_IS_INDISTINGUISHABLE: an account that does not exist gets the same 201 `{ id, status: "pending" }` as one that does (a random id), and nothing is written. A rejected ask for an unknown account leaves the subject's other pending ask untouched.
 *   - A store failure is 503 `authz_unavailable`, with its failure class logged and no message.
 * Side-effects: IO (service-role database write)
 * Links: https://node-template.cognidao.org/knowledge/node-relationships-design
 * @public
 */

import { AgentRolesError } from "@cogni/agent-grants";
import { payerBindingAskOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "payer-bindings.ask",
    bearerWrite: "asks to be billed to an account for the caller itself and grants nothing; an owner of that account decides, and only an approved binding makes a run bill it",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) return json({ error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = payerBindingAskOperation.input.safeParse(body);
    if (!parsed.success) return json({ error: "invalid input" }, 400);
    try {
      const outcome = await getContainer().agentAuthority.requestPayerBinding(sessionUser.id, parsed.data.billingAccountId);
      // One answer for a new ask, a repeat of the same ask and an ask for an account that does not exist: 201 `{ id, status: "pending" }`. Whether the binding is live is learned by use, never from the ask.
      return json(payerBindingAskOperation.output.parse({ id: outcome.id, status: "pending" }), 201);
    } catch (error) {
      if (error instanceof AgentRolesError) {
        if (error.code === "not_allowed") return json({ error: "already_bound" }, 409);
        if (error.code === "too_many_requests") return json({ error: "too_many_requests" }, 429);
      }
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "payer-bindings.ask", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
