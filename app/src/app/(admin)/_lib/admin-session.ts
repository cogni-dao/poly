// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/_lib/admin-session`
 * Purpose: The ONLY mint of an `AdminSession` (an admin decision). An admin route calls it first and passes it to `NodeAdminPort`.
 * Scope: Resolves the caller (a same-origin browser session or a bearer, through the one request resolver), then runs the one
 *   node-admin check on the caller's wallet. Decides nothing else.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_MINT: no other file casts to `AdminSession` (import-lock test).
 *   - ONE_ADMIN_CHECK (AUTHORITY_IS_NOT_KIND): a session and a bearer reach the same `agentAuthority.adminCheck`, on the wallets
 *     bound to the caller's user.
 *   - COOKIE_WRITES_ARE_SAME_ORIGIN (Red): a cookie write must carry an Origin whose host is the public host. Behind the ingress
 *     `request.url` is the in-pod bind address, so the public host is `x-forwarded-host`, else `host`. A missing or foreign Origin is refused.
 *   - FAIL_CLOSED_WITH_DISTINCTION: no session 401; not an admin 403 `authz_denied`; admin check down 503 `authz_unavailable`.
 *   - One `admin.action` log per minted decision: action name, admin user id and `via`, no credential.
 * Side-effects: IO (session read, repo-spec admin read, log)
 * Links: src/ports/node-admin.port.ts, src/bootstrap/node-admin-gate.ts, tests/unit/app/admin-acts-in-admin.test.ts
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import type { AdminSession } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

export type AdminSessionResult =
  | { readonly ok: true; readonly session: AdminSession }
  | { readonly ok: false; readonly response: NextResponse };

const refuse = (error: string, status: number): AdminSessionResult => ({
  ok: false,
  response: NextResponse.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  ),
});

function isPublicOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** `action` names the admin act for the `admin.action` log (for example `ai_access.list`). */
export async function requireAdminSession(
  request: Request,
  action: string,
): Promise<AdminSessionResult> {
  const container = getContainer();

  // A key-store outage or a rate-limited key is unavailable, never a pass.
  const user = await getSessionUser().catch(() => "unavailable" as const);
  if (user === "unavailable") return refuse("authz_unavailable", 503);
  if (!user) return refuse("unauthorized", 401);
  const via = request.headers
    .get("authorization")
    ?.toLowerCase()
    .startsWith("bearer ")
    ? "bearer"
    : "session";

  // A cookie write must originate at this page. A bearer carries its own credential and is not a cookie.
  if (via === "session" && request.method !== "GET" && !isPublicOrigin(request))
    return refuse("authz_denied", 403);

  // ONE_ADMIN_CHECK: the same `adminCheck` the tool guard and /api/v1/agent/me use: the caller is an admin when a wallet bound
  // to its user (SIWE writes the session's wallet binding at sign-in) is a node admin. Credential type never matters.
  const allowed = await container.agentAuthority
    .adminCheck(user.id)
    .catch(() => "unavailable" as const);
  if (allowed === "unavailable") return refuse("authz_unavailable", 503);
  if (allowed !== "allow") return refuse("authz_denied", 403);

  container.log.info(
    { event: EVENT_NAMES.ADMIN_ACTION, action, adminUserId: user.id, via },
    EVENT_NAMES.ADMIN_ACTION,
  );
  return {
    ok: true,
    session: Object.freeze({ userId: user.id }) as AdminSession,
  };
}
