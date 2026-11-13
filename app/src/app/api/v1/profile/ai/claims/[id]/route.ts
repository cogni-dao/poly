// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/profile/ai/claims/[id]`
 * Purpose: The claim row's data and its click, in the owner's "Your AIs" on the profile (`/profile?claim=<id>`). GET shows the agent and whether the claim can still be used;
 *   POST (the Claim click) makes the agent theirs.
 * Scope: Session guard, then the spawn store. Opening never claims: only the POST does.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`. A key never claims.
 *   - OWNER_IS_THE_CLICKER: the owner is the session's user id. Nothing in the request names an owner.
 *   - ONE_GUARDED_WRITE: the store sets `owner_user_id` once, only where it is NULL, on the claim's own agent; a used, expired or unknown claim changes nothing.
 *   - An agent is never an owner (403 `owner_is_agent`); a person owns at most 25 agents (409 `too_many_agents`).
 *   - NEVER_CACHED: every response is `no-store`.
 * Side-effects: IO (service-role database), logs `agent.owner.claimed`
 * Links: src/app/api/v1/agent/claim/route.ts, https://cognidao.org/work/items/task.5465
 * @public
 */

import {
  CredentialStoreUnavailableError,
  completeAgentClaim,
  credentialErrorHttp,
  readAgentClaim,
} from "@cogni/agent-grants/credentials";
import { agentClaimCompleteOperation, agentClaimViewOperation } from "@cogni/node-contracts";
import type { NextResponse } from "next/server";

import { noStoreJson, requirePersonSession } from "@/app/_lib/auth/person-session";
import { getAgentSpawnStore } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function outage(error: unknown): NextResponse {
  const http = credentialErrorHttp(error);
  if (error instanceof CredentialStoreUnavailableError && http) return noStoreJson(http.body, http.status);
  throw error;
}

export const GET = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "profile.ai.claim.view", auth: { mode: "none" } },
  async (_ctx, request, _user, context) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    if (!context) throw new Error("route_context_missing");
    const { id } = await context.params;
    try {
      const claim = await readAgentClaim(getAgentSpawnStore(), { claimId: id });
      return claim ? noStoreJson(agentClaimViewOperation.output.parse(claim)) : noStoreJson({ error: "not_found" }, 404);
    } catch (error) {
      return outage(error);
    }
  }
);

const REFUSALS = {
  unknown: [404, "not_found"],
  expired: [410, "claim_expired"],
  used: [409, "claim_used"],
  already_owned: [409, "already_owned"],
  owner_is_agent: [403, "owner_is_agent"],
  too_many_agents: [409, "too_many_agents"],
} as const;

export const POST = wrapRouteHandlerWithLogging<Ctx>(
  { routeId: "profile.ai.claim.complete", auth: { mode: "none" } },
  async (ctx, request, _user, context) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    if (!context) throw new Error("route_context_missing");
    const { id } = await context.params;
    try {
      const result = await completeAgentClaim(getAgentSpawnStore(), { claimId: id, ownerUserId: person.userId });
      if (!result.ok) {
        const [status, error] = REFUSALS[result.reason];
        return noStoreJson({ error }, status);
      }
      ctx.log.info({ event: EVENT_NAMES.AGENT_OWNER_CLAIMED, ownerUserId: person.userId, agentUserId: result.agentUserId }, EVENT_NAMES.AGENT_OWNER_CLAIMED);
      return noStoreJson(agentClaimCompleteOperation.output.parse({ claimed: true }));
    } catch (error) {
      return outage(error);
    }
  }
);
