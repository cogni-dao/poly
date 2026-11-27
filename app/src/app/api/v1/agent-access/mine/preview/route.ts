// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/agent-access/mine/preview`
 * Purpose: HUMAN plane, session only. A signed-in person who opened an AI's one-time link on `/profile` sends its token (read from the URL fragment) and
 *   gets back the waiting account ask as a table row, so the page shows and highlights it.
 * Scope: HTTP validation and the session read. Looks the ask up; decides nothing and writes nothing.
 * Invariants:
 *   - HUMAN_ROUTES_SESSION_ONLY: any `Authorization` header is 403 `human_session_required` before anything is read.
 *   - NON_DISCLOSING: a wrong-kind (a node token), used, expired or unknown token is ONE answer: 404 `not_found`.
 *   - TOKEN_IN_BODY_ONLY: the token is POSTed; the response carries no token.
 * Side-effects: IO (service-role database read)
 * Links: packages/agent-grants (previewAsk)
 * @public
 */

import { mineRoute } from "@/app/_lib/agent-access/routes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = mineRoute("agent.mine.preview", "preview", true);
