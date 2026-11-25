// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/confirm`
 * Purpose: Called WITH the pending successor key (that proves the caller stored it): one transaction activates it and revokes its predecessor.
 *   After this the old key is dead (zero overlap after confirm).
 * Scope: Auth shell and delegation. The transaction and the result-to-HTTP mapping (`credentialHttp`) live in `@cogni-dao/agent-grants/credentials`.
 * Invariants:
 *   - IDEMPOTENT: confirming an already active key is 200 with `replay: true`. A revoked key never reaches here (401); a race that revokes it
 *     first is 409 `superseded`. An upgrade key whose user gained roles and has no GitHub binding is 409 `binding_required` (BINDING_BEFORE_UPGRADE, re-checked at confirm). A predecessor revoked meanwhile is 409 `predecessor_revoked`; an unconfirmed key past its window is 409 `pending_expired`.
 *   - DB clock decides expiry. Never logs a key.
 * Side-effects: IO (service-role db), log `agent.credential.confirmed`
 * Links: https://cognidao.org/work/items/task.5474
 * @public
 */

import { confirmCredential, credentialHttp } from "@cogni/agent-grants/credentials";

import { credentialBearerRoute, credentialResponse } from "@/app/_lib/auth/agent-credential-route";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = credentialBearerRoute({
  routeId: "agent.credentials.confirm",
  allow: ["pending", "active"],
  async handle({ ctx, caller }) {
    const result = await confirmCredential(getAgentCredentialStore(), { credentialId: caller.credentialId });
    if (result.ok && result.status === "confirmed") {
      ctx.log.info(
        { event: EVENT_NAMES.AGENT_CREDENTIAL_CONFIRMED, userId: result.userId, credentialId: caller.credentialId },
        EVENT_NAMES.AGENT_CREDENTIAL_CONFIRMED
      );
    }
    return credentialResponse(credentialHttp({ op: "confirm", credentialId: caller.credentialId, result }));
  },
});
