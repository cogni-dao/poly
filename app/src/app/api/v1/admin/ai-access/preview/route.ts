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

import { adminRoute } from "@/app/api/v1/admin/_lib/ai-access-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = adminRoute("admin.ai-access.preview", "ai_access.preview", "preview", true);
