// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/ai-access`
 * Purpose: ADMIN area, human plane. A node-admin, signed in, lists this node's AI (GET) and turns a permission On (POST: approve a pending ask,
 *   or grant one of this node's AI) or Off (DELETE: revoke, or `deny: true` to dismiss an ask) by clicking on `/admin/ai-access`.
 * Scope: HTTP validation and the mint. Every handler gets its `AdminSession` from `requireAdminSession()` and calls `NodeAdminPort` with it. No authority logic.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN: the only door for these writes. The old `/api/v1/agent-access/roles` route is gone (404). The AI plane has no twin: an agent asks at `/api/v1/agent/access-requests`; a human admin decides here.
 *   - ONE_ADMIN_CHECK: a session or a bearer reaches the mint, which runs the one node-admin check on the caller's wallet.
 *   - FAIL_CLOSED_WITH_DISTINCTION: non-admin 403 `authz_denied`; no configured admins 503 `authz_unavailable`.
 *   - NODE_DECLARED_SCOPES: an undeclared scope is 400 before any write.
 *   - ADMIN_NEVER_SHOWS_ACCOUNT_ROWS (ONE_GATE): this table lists and decides NODE rows only. An account permission is its owner's alone, on the profile.
 *     A one-time link to a waiting node ask highlights through `POST /api/v1/admin/ai-access/preview`.
 * Side-effects: IO (service-role database read and write), logs `admin.action` and `agent_role.*`
 * Links: src/app/(admin)/_lib/admin-session.ts, src/ports/node-admin.port.ts, https://cognidao.org/knowledge/node-capability-grants-standard
 * @public
 */

import { adminRoute } from "@/app/api/v1/admin/_lib/ai-access-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = adminRoute("admin.ai-access.list", "ai_access.list", "list", false);
export const POST = adminRoute("admin.ai-access.on", "ai_access.on", "on", true);
export const DELETE = adminRoute("admin.ai-access.off", "ai_access.off", "off", true);
