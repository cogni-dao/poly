// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(admin)/_lib/admin-session`
 * Purpose: The ONLY mint of an `AdminSession`. An admin route calls it first and passes the session to `NodeAdminPort`.
 * Scope: Refuses any Authorization header, reads the browser session, runs the container's one `NodeAdminAuthority.check`. Decides nothing else.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_MINT: no other file casts to `AdminSession` (import-lock test).
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required`, before any session or admin read. A key never mints.
 *   - FAIL_CLOSED_WITH_DISTINCTION: no session 401; not an admin 403 `authz_denied`; admin check down 503 `authz_unavailable`.
 *   - One `admin.action` log per minted session: action name and admin user id, no credential.
 * Side-effects: IO (session read, repo-spec admin read, log)
 * Links: src/ports/node-admin.port.ts, src/bootstrap/node-admin-gate.ts, tests/unit/app/admin-acts-in-admin.test.ts
 * @public
 */

import { NextResponse } from "next/server";

import { refuseNonSession } from "@/app/_lib/auth/human-plane";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import type { AdminSession } from "@/ports";
import { EVENT_NAMES } from "@/shared/observability";

export type AdminSessionResult =
  | { readonly ok: true; readonly session: AdminSession }
  | { readonly ok: false; readonly response: NextResponse };

const refuse = (error: string, status: number): AdminSessionResult => ({
  ok: false,
  response: NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } }),
});

/** `action` names the admin act for the `admin.action` log (for example `ai_access.list`). */
export async function requireAdminSession(request: Request, action: string): Promise<AdminSessionResult> {
  const container = getContainer();
  const refused = refuseNonSession(request, container.log);
  if (refused) return { ok: false, response: refused };

  const user = await getSessionUser();
  if (!user || user.via !== "session") return refuse("unauthorized", 401);

  const decision = await container.nodeAdmin
    .check({ userId: user.id, walletAddress: user.walletAddress })
    .catch(() => ({ ok: false, errorCode: "authz_unavailable" }) as const);
  if (!decision.ok) {
    return decision.errorCode === "authz_unavailable"
      ? refuse("authz_unavailable", 503)
      : refuse("authz_denied", 403);
  }

  container.log.info({ event: EVENT_NAMES.ADMIN_ACTION, action, adminUserId: user.id }, EVENT_NAMES.ADMIN_ACTION);
  return { ok: true, session: Object.freeze({ userId: user.id }) as AdminSession };
}
