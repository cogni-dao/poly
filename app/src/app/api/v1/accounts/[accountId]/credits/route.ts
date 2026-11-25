// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/accounts/[accountId]/credits`
 * Purpose: Gated read of ONE account's credits. The route twin of the tool `core__account_credits_read` (SAME_DOOR, scope `account:read`): the account's
 *   owner by session, or an outside AI by bearer once the owner turned the permission On for exactly this account.
 * Scope: HTTP validation and the read. The door (`sameDoor` + `sameDoorAccountParam`) decides owner | delegated | nothing before this handler runs.
 * Invariants:
 *   - ACCOUNT_404_NON_DISCLOSING: a foreign, expired, revoked, wrong-scope or missing account is ONE answer: 404 `not_found`. An outage is 503.
 *   - RLS_DECIDES_ROWS: the read runs in an app-role tenant transaction with `app.current_user_id` = the CALLER (the owner, or the agent), never the service
 *     role. A delegated agent sees the rows only through `agent_has_scope`, so the app door and the database cannot disagree.
 * Side-effects: IO (RLS-scoped read of billing_accounts and credit_ledger)
 * Links: packages/agent-grants (authorizeAccount), https://cognidao.org/knowledge/grant-account-outside-ai
 * @public
 */

import { creditsSummaryOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { readAccountCredits } from "@/app/_facades/payments/account-credits.server";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

type Ctx = { params: Promise<{ accountId: string }> };

export const GET = wrapRouteHandlerWithLogging<Ctx>(
  {
    routeId: "accounts.credits.read",
    sameDoor: "core__account_credits_read",
    sameDoorAccountParam: "accountId",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request, sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { accountId } = await context.params;
    const parsed = creditsSummaryOperation.input.safeParse({
      limit: new URL(request.url).searchParams.get("limit")
        ? Number(new URL(request.url).searchParams.get("limit"))
        : undefined,
    });
    if (!parsed.success) return json({ error: "Invalid query" }, 400);
    // The caller is the RLS actor: an owner reads through the owner policy, an agent through agent_has_scope.
    const summary = await readAccountCredits({ callerUserId: sessionUser.id, accountId, limit: parsed.data.limit });
    return summary ? json(creditsSummaryOperation.output.parse(summary)) : json({ error: "not_found" }, 404);
  }
);
