// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/profile/ai/revoke`
 * Purpose: The owner ends every live key of an agent they own, by clicking Revoke on "Your AIs". The agent's very next call is 401.
 * Scope: Session guard, body parse, delegation to `revokeOwnedAgentKeys` (which reuses the credential store's own revoke).
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`.
 *   - OWNER_SEES_ONLY_OWN: another person's agent, an ownerless agent and an unknown id are the same 404 `not_found`. Revoke never asks (page rule).
 *   - NEVER_CACHED: the next verify of a revoked key reads the revoked row.
 * Side-effects: IO (service-role db), logs `agent.owner.revoked`
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

import {
  CredentialStoreUnavailableError,
  credentialErrorHttp,
  revokeOwnedAgentKeys,
} from "@cogni/agent-grants/credentials";
import { ownedAgentRevokeOperation } from "@cogni/node-contracts";

import { noStoreJson, requirePersonSession } from "@/app/_lib/auth/person-session";
import { getAgentCredentialStore, getAgentSpawnStore } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "profile.ai.revoke", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    const parsed = ownedAgentRevokeOperation.input.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return noStoreJson({ error: "invalid input" }, 400);
    try {
      const result = await revokeOwnedAgentKeys(getAgentSpawnStore(), getAgentCredentialStore(), {
        ownerUserId: person.userId,
        agentUserId: parsed.data.agentId,
      });
      if (!result.ok) return noStoreJson({ error: "not_found" }, 404);
      ctx.log.info(
        { event: EVENT_NAMES.AGENT_OWNER_REVOKED, ownerUserId: person.userId, agentUserId: parsed.data.agentId, revoked: result.revoked },
        EVENT_NAMES.AGENT_OWNER_REVOKED
      );
      return noStoreJson(ownedAgentRevokeOperation.output.parse({ agentId: parsed.data.agentId, revoked: result.revoked }));
    } catch (error) {
      const http = credentialErrorHttp(error);
      if (error instanceof CredentialStoreUnavailableError && http) return noStoreJson(http.body, http.status);
      throw error;
    }
  }
);
