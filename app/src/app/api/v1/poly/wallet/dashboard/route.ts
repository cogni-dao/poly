// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/dashboard/route`
 * Purpose: Owner-session transport for `poly.account.portfolio-snapshot.v1` —
 *   one coherent, DB-only portfolio snapshot for the signed-in tenant.
 * Scope: Transport binding only. This module resolves a principal, names a
 *   capability, and serializes the outcome. It holds ZERO queries and ZERO
 *   authorization of its own.
 * Invariants:
 *   - ROUTE_IS_TRANSPORT_ONLY — no `db.`, no `resolveServiceDb`, no
 *     `resolveServiceReadDb`, no tenant resolution, no cache. Every one of
 *     those moved into the capability plane. The handle this route names is
 *     `resolveAppDb`, so RLS stays the backstop under the read.
 *   - NO_LAZY_ACCOUNT_ON_GET — `resolveBillingAccountId` is gone. It lazily
 *     INSERTed a billing account on miss, which is how a delegated agent
 *     bearer used to receive a 200 describing a brand-new empty tenant of its
 *     own instead of a denial. No GET in this plane can create an account.
 *   - SUBJECT_IS_NOT_CALLER — with no account id on the wire, the plane
 *     resolves the single account this principal can REACH for `account:read`
 *     (live grants union owned), not the account it happens to own. That is
 *     what closes the bearer hole on this route: an agent principal owns a
 *     freshly created account (`/agent/register` is unauthenticated and calls
 *     `getOrCreateBillingAccountForUser`), so "owned" would have handed it its
 *     own empty tenant with a 200. Reachable-by-several is a 400 that names the
 *     count and not the ids; reachable-by-none is a non-disclosing 404.
 *   - PAGE_LOAD_DB_ONLY / SAVED_FACTS_ONLY — unchanged: no upstream API call
 *     on render, and the whole read now additionally runs under the executor's
 *     `REPEATABLE READ READ ONLY` snapshot.
 *   - RESPONSE_IS_A_SUPERSET — the body is the portfolio snapshot, which is
 *     the dashboard contract plus `readiness`. Existing clients validating
 *     against `PolyWalletDashboardOutputSchema` are unaffected.
 *   - SNAPSHOT_HEADER_PRESERVED — `X-Wallet-Snapshot-Id` still echoes the
 *     snapshot id, which is why this route calls the executor directly rather
 *     than through `accountReadGetHandler` (that adapter emits no headers).
 * Side-effects: IO (DB reads via the capability plane).
 * Links: packages/poly-node-contracts/src/poly.account.portfolio-snapshot.v1.contract.ts,
 *   docs/spec/capability-plane.md, story.5004, task.1791070962
 * @public
 */

import { polyAccountReadPortfolioSnapshotOwnerOperation } from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveAppDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { isPolyTraderWalletConfigured } from "@/bootstrap/poly-trader-wallet";
import {
  ACCOUNT_READ_HTTP_STATUS,
  executeAccountRead,
  PORTFOLIO_SNAPSHOT_TERMINAL_EVENT,
  portfolioSnapshotAccountReadHandler,
  portfolioSnapshotExtra,
  type WalletDashboardReadDiagnostics,
} from "@/features/capability-plane";
import { serverEnv } from "@/shared/env/server-env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.wallet.dashboard",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) throw new Error("sessionUser required");

    const buildSha = serverEnv().APP_BUILD_SHA ?? "unknown";
    const operation = polyAccountReadPortfolioSnapshotOwnerOperation;
    const diagnostics: WalletDashboardReadDiagnostics = {
      comparisonPath: "cache_hit",
    };

    const outcome = await executeAccountRead({
      db: resolveAppDb(),
      ctx,
      operation,
      principalId: sessionUser.id,
      rawInput: Object.fromEntries(
        new URL(request.url).searchParams.entries()
      ),
      eventName: PORTFOLIO_SNAPSHOT_TERMINAL_EVENT,
      handler: portfolioSnapshotAccountReadHandler({
        adapterConfigured: isPolyTraderWalletConfigured(),
        diagnostics,
      }),
      extra: (context) => portfolioSnapshotExtra(context, buildSha, diagnostics),
    });

    switch (outcome.status) {
      case "ok":
        return NextResponse.json(outcome.data, {
          headers: {
            "Cache-Control": "private, no-store",
            "X-Wallet-Snapshot-Id": outcome.data.snapshotId,
            "X-Request-Id": ctx.reqId ?? "unknown",
          },
        });
      case "invalid_input":
        return NextResponse.json(
          {
            error: "invalid_query",
            ...(outcome.message ? { message: outcome.message } : {}),
          },
          { status: ACCOUNT_READ_HTTP_STATUS.invalid_input }
        );
      case "denied":
      case "not_found":
        // Indistinguishable by design: "you own no account", "that account is
        // not yours", and "no such account" are one response.
        return NextResponse.json(
          { error: "not_found" },
          { status: ACCOUNT_READ_HTTP_STATUS.denied }
        );
      default:
        return NextResponse.json(
          { error: "Internal server error" },
          { status: ACCOUNT_READ_HTTP_STATUS.failed }
        );
    }
  }
);
