// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/access-requests/_bearer-transport`
 * Purpose: Require a non-empty machine credential on bearer-only routes.
 * Scope: Authorization-header shape only; token verification remains in the
 *   request-identity resolver.
 * Invariants: browser session fallback never satisfies this transport guard.
 * Side-effects: none
 * @internal
 */

const AGENT_TOKEN_PREFIX = "cogni_ag_sk_v1_";

export function isAgentBearerRequest(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.toLowerCase().startsWith("bearer ")) return false;
  const credential = authorization.slice(7).trim();
  return (
    credential.startsWith(AGENT_TOKEN_PREFIX) &&
    credential.length > AGENT_TOKEN_PREFIX.length
  );
}
