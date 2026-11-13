// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/claim`
 * Purpose: AI plane (bearer only). An EXISTING agent with no owner asks to become a person's. It answers with `claimUrl` (`/profile?claim=<id>`), a deep link into the person's
 *   profile that the agent hands over; the person's Claim click there makes the agent theirs. Same principal, same history (ONE_IDENTITY).
 * Scope: Bearer-only plane rule and delegation to the spawn store. No human secret: nothing travels through the person except a link.
 * Invariants:
 *   - KIND_PICKS_THE_PLANE: a browser session (or any identity that is not a verified bearer) gets 404.
 *   - SELF_REQUEST_ONLY: the caller's own user id is the agent. The body names nothing, so an agent cannot claim for another.
 *   - The link is single use, lasts 15 minutes and is bound to this agent. A new request ends the earlier open link. An agent that already has an owner is 409 `already_owned`; an
 *     internal AI or a user with a wallet is 403 `not_an_agent`.
 *   - The origin of the link comes from config, never from the Host header.
 * Side-effects: IO (service-role database write), logs `agent.claim.started`
 * Links: https://cognidao.org/work/items/task.5465, src/app/api/v1/profile/ai/claims/[id]/route.ts
 * @public
 */

import { claimPath } from "@cogni/agent-grants";
import { CredentialStoreUnavailableError, credentialErrorHttp, startAgentClaim } from "@cogni/agent-grants/credentials";
import { agentClaimStartOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { configuredUrl } from "@/app/_lib/agent-access/setup-line";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentSpawnStore } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.claim.start", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) => {
    if (!sessionUser || sessionUser.via !== "bearer") return json({ error: "not_found" }, 404);
    try {
      const started = await startAgentClaim(getAgentSpawnStore(), { agentUserId: sessionUser.id });
      if (!started.ok) return started.reason === "already_owned" ? json({ error: "already_owned" }, 409) : json({ error: "not_an_agent" }, 403);
      ctx.log.info({ event: EVENT_NAMES.AGENT_CLAIM_STARTED, agentUserId: sessionUser.id, expiresAt: started.expiresAt }, EVENT_NAMES.AGENT_CLAIM_STARTED);
      return json(
        agentClaimStartOperation.output.parse({ claimUrl: configuredUrl(claimPath(started.claimId)), expiresAt: started.expiresAt }),
        201
      );
    } catch (error) {
      const http = credentialErrorHttp(error);
      if (error instanceof CredentialStoreUnavailableError && http) return json(http.body, http.status);
      throw error;
    }
  }
);
