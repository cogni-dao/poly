// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_lib/agent-access/respond`
 * Purpose: The three framework lines every agent access route needs around a `@cogni/agent-grants/http` core: read the JSON body, send the core's response,
 *   and log an unavailable store under the registered event with this node's failure fields.
 * Scope: Next-side wiring only. The cores own every status, body and refusal.
 * Side-effects: none (the logger is the caller's)
 * @internal
 */

import type { AgentHttpDeps, AgentHttpResponse } from "@cogni/agent-grants/http";
import { NextResponse } from "next/server";

import { EVENT_NAMES, failureFields } from "@/shared/observability";

/** The request's JSON body, or `undefined` when it is not JSON (the core answers 400). */
export const readJsonBody = (request: Request): Promise<unknown> => request.json().catch(() => undefined);

/** Send a route core's response. */
export const send = (response: AgentHttpResponse): NextResponse =>
  NextResponse.json(response.body, { status: response.status, headers: response.headers });

/** The deps every core takes: an unavailable store is one registered error line with the failure class (never a message, token or hash). */
export const httpDeps = (log: { error: (fields: Record<string, unknown>, event: string) => void }): AgentHttpDeps => ({
  onUnavailable: (routeId, error) =>
    log.error(
      { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId, ...failureFields(error) },
      EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
    ),
});
