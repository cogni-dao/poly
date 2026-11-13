// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/credentials/upgrade`
 * Purpose: A valid v1 agent key mints a PENDING revocable key for the SAME users.id (task.0070, child of task.5474). The caller stores the
 *   revocable key, then calls `confirm` with it.
 * Scope: v1-bearer gate and delegation. The key, the principal row, every refusal rule and the result-to-HTTP mapping (`credentialHttp`) live in
 *   `@cogni-dao/agent-grants/credentials`.
 * Invariants:
 *   - V1_ONLY: the caller must authenticate with a signed key (a session or a revocable key is 403 `signed_key_required`). An expired signed key never reaches
 *     here (the resolver answers 401).
 *   - Refuses a wallet user and an internal principal (403 `not_agent_key`), a user that already holds a live revocable key (409 `already_upgraded`),
 *     and a principal with node roles and no GitHub binding (409 `binding_required`, BINDING_BEFORE_UPGRADE).
 *   - The signed key keeps working while the revocable key is only pending. Once the revocable key is confirmed the signed key is superseded (401 `v1_superseded`, resolver).
 *     Never logs or stores a key. A store failure at any step is 503 `authz_unavailable`.
 * Side-effects: IO (service-role db), log `agent.credential.upgraded`
 * Links: https://cognidao.org/work/items/task.5474, https://cognidao.org/work/items/task.0070
 * @public
 */

import { type CredentialHttpInput, credentialHttp, upgradeSignedKey } from "@cogni/agent-grants/credentials";

import { answerStoreOutage, credentialResponse } from "@/app/_lib/auth/agent-credential-route";
import { currentBearerToken } from "@/app/_lib/auth/request-identity";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getAgentCredentialStore } from "@/bootstrap/agent-credentials";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "agent.credentials.upgrade", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) => {
    /** One log line per refusal; the status, body and headers come from the package's mapping. */
    const answer = (input: CredentialHttpInput) => {
      const res = credentialHttp(input);
      if (res.refusal) {
        ctx.log.warn(
          { event: EVENT_NAMES.AGENT_CREDENTIAL_REFUSED, routeId: "agent.credentials.upgrade", userId: sessionUser.id, reason: res.refusal },
          EVENT_NAMES.AGENT_CREDENTIAL_REFUSED
        );
      }
      return credentialResponse(res);
    };
    const bearer = await currentBearerToken();
    if (sessionUser.via !== "bearer" || !bearer?.startsWith("cogni_ag_sk_v1_")) return answer({ op: "signed_key_required" });

    return answerStoreOutage(ctx, "agent.credentials.upgrade", async () => {
      const minted = await upgradeSignedKey(getAgentCredentialStore(), { userId: sessionUser.id });
      if (!minted.ok) return answer({ op: "upgrade", result: minted });
      ctx.log.info(
        { event: EVENT_NAMES.AGENT_CREDENTIAL_UPGRADED, userId: minted.userId, credentialId: minted.credentialId },
        EVENT_NAMES.AGENT_CREDENTIAL_UPGRADED
      );
      return answer({ op: "upgrade", result: minted });
    });
  }
);
