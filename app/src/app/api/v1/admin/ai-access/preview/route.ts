// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/admin/ai-access/preview`
 * Purpose: ADMIN area, human plane. A node-admin who opened an AI's one-time link on `/admin/ai-access` sends its token (read from the URL fragment) and gets
 *   back the waiting ask as a table row, so the page highlights it.
 * Scope: HTTP validation and the mint. Looks the ask up; decides nothing and writes nothing.
 * Invariants:
 *   - ADMIN_ACTS_IN_ADMIN / ONE_ADMIN_CHECK: the mint (`requireAdminSession`) runs first, for a session or a bearer.
 *   - NON_DISCLOSING: a wrong-kind (an account token), used, expired or unknown token is ONE answer: 404 `not_found`.
 *   - TOKEN_IN_BODY_ONLY: the token is POSTed, never put in a URL path or query; the response carries no token.
 * Side-effects: IO (service-role database read), logs `admin.action`
 * Links: src/app/(admin)/_lib/admin-session.ts, packages/agent-grants (previewAsk)
 * @public
 */

import { agentPreviewOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { requireAdminSession } from "@/app/(admin)/_lib/admin-session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EVENT_NAMES, failureFields } from "@/shared/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export const POST = wrapRouteHandlerWithLogging(
  { routeId: "admin.ai-access.preview", auth: { mode: "none" } },
  async (ctx, request) => {
    const admin = await requireAdminSession(request, "ai_access.preview");
    if (!admin.ok) return admin.response;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const parsed = agentPreviewOperation.input.safeParse(body);
    // A token of the wrong shape is the same answer as an unknown one.
    if (!parsed.success) return json({ error: "not_found" }, 404);
    try {
      const permission = await getContainer().nodeAdminPort.previewAiRequest(admin.session, parsed.data.token);
      if (!permission) return json({ error: "not_found" }, 404);
      return json(agentPreviewOperation.output.parse({ permission }));
    } catch (error) {
      ctx.log.error({ event: EVENT_NAMES.AGENT_ROLES_UNAVAILABLE, routeId: "admin.ai-access.preview", ...failureFields(error) }, EVENT_NAMES.AGENT_ROLES_UNAVAILABLE);
      return json({ error: "authz_unavailable" }, 503);
    }
  }
);
