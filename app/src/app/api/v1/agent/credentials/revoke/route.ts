// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/revoke`
 * Purpose: Revoke one revocable key of the caller's own user: the calling key (no body) or a sibling by `credentialId` (leak response).
 *   The revoked key answers 401 on its next call; every other key stays valid (A7). A pending successor of the revoked key dies with it.
 * Scope: Auth shell, body parse, delegation. SQL and the result-to-HTTP mapping (`credentialHttp`) live in `@cogni-dao/agent-grants/credentials`.
 * Invariants:
 *   - OWN_KEYS_ONLY: another user's credential id, a revoked id and an unknown id are all the same 404 `not_found`.
 *   - NEVER_CACHED: the very next verify reads the revoked row.
 * Side-effects: IO (service-role db), log `agent.credential.revoked`
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

import { credentialHttp, revokeCredential } from "@cogni/agent-grants/credentials";
import { revokeAgentCredentialOperation } from "@cogni/node-contracts";

import { credentialBearerRoute, credentialResponse } from "@/app/_lib/auth/agent-credential-route";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = credentialBearerRoute({
  routeId: "agent.credentials.revoke",
  allow: ["active", "renew_only"],
  async handle({ ctx, request, caller }) {
    const body = await request.json().catch(() => ({}));
    const parsed = revokeAgentCredentialOperation.input.safeParse(body ?? {});
    if (!parsed.success) return credentialResponse(credentialHttp({ op: "invalid_input" }));
    const credentialId = parsed.data.credentialId ?? caller.credentialId;

    const revoked = await revokeCredential(getAgentCredentialStore(), {
      credentialId,
      userId: caller.userId,
      revokedBy: caller.userId,
    });
    if (revoked) {
      ctx.log.info(
        { event: EVENT_NAMES.AGENT_CREDENTIAL_REVOKED, userId: caller.userId, credentialId, viaCredentialId: caller.credentialId },
        EVENT_NAMES.AGENT_CREDENTIAL_REVOKED
      );
    }
    return credentialResponse(credentialHttp({ op: "revoke", credentialId, revoked }));
  },
});
