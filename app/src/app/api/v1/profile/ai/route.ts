// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/profile/ai`
 * Purpose: A signed-in person's own AIs, on their profile ("Your AIs"). GET lists the agents they own. POST ("Add an AI") issues a one-time
 *   spawn grant and returns ONE copyable setup line for the agent: the only place the secret is shown.
 * Scope: Session guard, input shaping and delegation to `@cogni-dao/agent-grants/credentials`. No admin check: these are the person's own agents.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required` (`requirePersonSession`).
 *   - APPROVER_FOLLOWS_RESOURCE: the person's own rows, the person decides. No node-wide toggle, no node grant, nothing from /admin appears here.
 *   - OWNER_SEES_ONLY_OWN: the list is keyed on the session's user id, never on a request field.
 *   - HUMAN_SURFACE_TOKENLESS: the list holds no key, hash, grant or credential id. The grant leaves only in the POST answer.
 *   - CAPPED: 5 pending grants per person; the 6th is 429 `too_many_pending`.
 *   - NEVER_CACHED: every response is `no-store`.
 * Side-effects: IO (service-role db), logs `agent.spawn_grant.issued`
 * Links: https://cognidao.org/knowledge/node-capability-grants-standard, https://cognidao.org/work/items/task.5474
 * @public
 */

import {
  CredentialStoreUnavailableError,
  credentialErrorHttp,
  issueSpawnGrant,
  listOwnedAgents,
  MAX_PENDING_SPAWN_GRANTS,
  spawnGrantsLeft,
} from "@cogni/agent-grants/credentials";
import { ownedAgentIssueOperation, ownedAgentsListOperation } from "@cogni/node-contracts";
import type { NextResponse } from "next/server";

import { buildSetupLine, publicOrigin } from "@/app/_lib/agent-access/setup-line";
import { noStoreJson, requirePersonSession } from "@/app/_lib/auth/person-session";
import { getAgentSpawnStore } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A store outage is 503 `authz_unavailable`, never a 500 or a refusal. Other errors propagate. */
function outage(error: unknown): NextResponse {
  const http = credentialErrorHttp(error);
  if (error instanceof CredentialStoreUnavailableError && http) return noStoreJson(http.body, http.status);
  throw error;
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "profile.ai.list", auth: { mode: "none" } },
  async (_ctx, request) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    try {
      const store = getAgentSpawnStore();
      const [agents, grantsLeft] = await Promise.all([
        listOwnedAgents(store, { ownerUserId: person.userId }),
        spawnGrantsLeft(store, { issuerUserId: person.userId }),
      ]);
      return noStoreJson(
        ownedAgentsListOperation.output.parse({
          agents: agents.map((a) => ({ agentId: a.agentUserId, name: a.name, createdAt: a.createdAt, keyState: a.keyState })),
          grantsLeft,
        })
      );
    } catch (error) {
      return outage(error);
    }
  }
);

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "profile.ai.issue", auth: { mode: "none" } },
  async (ctx, request) => {
    const person = await requirePersonSession(request);
    if (!person.ok) return person.response;
    try {
      const issued = await issueSpawnGrant(getAgentSpawnStore(), { issuerUserId: person.userId });
      if (!issued.ok) {
        ctx.log.warn(
          { event: EVENT_NAMES.AGENT_SPAWN_GRANT_REFUSED, routeId: "profile.ai.issue", reason: issued.reason, issuerUserId: person.userId },
          EVENT_NAMES.AGENT_SPAWN_GRANT_REFUSED
        );
        return issued.reason === "too_many_pending"
          ? noStoreJson({ error: "too_many_pending" }, 429)
          : noStoreJson({ error: "forbidden" }, 403);
      }
      ctx.log.info(
        { event: EVENT_NAMES.AGENT_SPAWN_GRANT_ISSUED, issuerUserId: person.userId, expiresAt: issued.expiresAt, pending: issued.pending },
        EVENT_NAMES.AGENT_SPAWN_GRANT_ISSUED
      );
      return noStoreJson(
        ownedAgentIssueOperation.output.parse({
          setupLine: buildSetupLine({ origin: publicOrigin(request), grant: issued.grant, expiresAt: issued.expiresAt }),
          expiresAt: issued.expiresAt,
          grantsLeft: Math.max(0, MAX_PENDING_SPAWN_GRANTS - issued.pending),
        }),
        201
      );
    } catch (error) {
      return outage(error);
    }
  }
);
