// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent/me`
 * Purpose: The self-check. Any caller, session or bearer, reads who it is: its bound wallets, whether the node-admin
 *   check passes, and its live grants.
 * Scope: Read-only, own data. Delegates every decision to the agent authority; decides nothing itself.
 * Invariants:
 *   - ONE_ADMIN_CHECK: `isAdmin` is the same `adminCheck` the admin mint and the tool guard use, on the caller's bound wallets,
 *     so this probe and an admin route always agree for the same caller.
 *   - `via` is the credential (the Authorization header); `kind` is `org` for an org principal, `agent` for any other `agent_principals` row (written at registration, backfilled for earlier agents), else `human`.
 *   - OWN_DATA_ONLY: the caller's own user id is the only input; the response names no other principal.
 *   - FAIL_CLOSED_NON_DISCLOSING: a store or admin outage is 503 `authz_unavailable`, never a partial answer.
 * Side-effects: IO (service-role database reads)
 * Links: https://node-template.cognidao.org/knowledge/identity-north-star-design, task.0141
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "agent.me", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser) => {
    // This node resolves identity without a `via` mark: a bearer header is the machine credential (same test as the admin mint).
    const via =
      request.headers.get("authorization")?.toLowerCase().startsWith("bearer ") === true
        ? "bearer"
        : "session";
    try {
      const authority = getContainer().agentAuthority;
      const [wallets, admin, rows, kind] = await Promise.all([
        authority.boundWallets(sessionUser.id),
        authority.adminCheck(sessionUser.id),
        authority.listOwnAccess(sessionUser.id),
        authority.principalKind(sessionUser.id),
      ]);
      if (admin === "unavailable") return json({ error: "authz_unavailable" }, 503);
      return json({
        userId: sessionUser.id,
        via,
        kind,
        wallets,
        isAdmin: admin === "allow",
        grants: rows
          .filter((row) => row.state === "granted")
          .map((row) => ({ scope: row.scope, accountId: row.accountId, since: row.at })),
      });
    } catch (error) {
      ctx.log.error(
        { event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "agent.me", ...failureFields(error) },
        EVENT_NAMES.AGENT_ROLES_UNAVAILABLE
      );
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
