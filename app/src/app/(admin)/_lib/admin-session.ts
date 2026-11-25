// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Sole opaque AI-admin session mint. Same identity and authority for cookies/bearers. */
import { NextResponse } from "next/server";
import type { Logger } from "pino";

import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import type { AdminSession } from "@/ports/node-admin.port";
import { EVENT_NAMES } from "@/shared/observability";

export type AdminSessionResult =
  | { readonly ok: true; readonly session: AdminSession }
  | {
      readonly ok: false;
      readonly response: NextResponse;
      readonly actorUserId: string | null;
      readonly reason: string;
    };

const refuse = (
  error: string,
  status: number,
  actorUserId: string | null,
  reason: string,
): AdminSessionResult => ({
  actorUserId,
  reason,
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

export async function requireAdminSession(
  request: Request,
  action: string,
  auditLog?: Logger,
): Promise<AdminSessionResult> {
  let actorUserId: string | null = null;
  let unavailableReason = "identity_unavailable";
  try {
    const user = await getSessionUser();
    if (!user) return refuse("unauthorized", 401, null, "identity_required");
    actorUserId = user.id;
    unavailableReason = "admin_check_unavailable";
    const bearer =
      request.headers
        .get("authorization")
        ?.toLowerCase()
        .startsWith("bearer ") === true;
    // Cookie mutations must originate at this page. JSON is also enforced by the route.
    // Behind the ingress `request.url` is the in-pod bind address, so compare the public host.
    if (
      !bearer &&
      request.method !== "GET" &&
      !isPublicOrigin(request)
    ) {
      return refuse("authz_denied", 403, actorUserId, "origin_refused");
    }
    const container = getContainer();
    const allowed = await container.agentAuthority.adminCheck(
      user.id,
    );
    if (allowed === "unavailable")
      return refuse("authz_unavailable", 503, actorUserId, unavailableReason);
    if (allowed !== "allow")
      return refuse("authz_denied", 403, actorUserId, "not_node_admin");
    (auditLog ?? container.log).info(
      {
        event: EVENT_NAMES.ADMIN_ACTION,
        action,
        adminUserId: user.id,
        via: bearer ? "bearer" : "session",
      },
      EVENT_NAMES.ADMIN_ACTION,
    );
    return {
      ok: true,
      session: Object.freeze({ userId: user.id }) as AdminSession,
    };
  } catch {
    return refuse("authz_unavailable", 503, actorUserId, unavailableReason);
  }
}
