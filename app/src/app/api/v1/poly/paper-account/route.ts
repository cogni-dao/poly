// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/paper-account`
 * Purpose: HTTP POST — create (idempotently) the calling user's paper trading
 *   account: a `poly_wallet_connections` row with `kind = 'paper'` plus the
 *   default `poly_wallet_grants` row, so paper is a first-class tenant that
 *   every existing account reader can see.
 * Scope: Wire-shape + auth boundary only. The write lives in
 *   `provisionPaperAccount`. No UI, no Privy, no chain, no real funds.
 * Invariants:
 *   - TENANT_SCOPED: the tenant is resolved server-side from the session's
 *     billing account via the accounts container; the body cannot override it.
 *   - RLS_IS_THE_SECOND_LOCK: the write goes through the app-role client inside
 *     `withTenantScope`, so `tenant_isolation`'s WITH CHECK clause independently
 *     re-proves the row belongs to the caller. This route deliberately does NOT
 *     use the BYPASSRLS service role.
 *   - NO_PRIVY_DEPENDENCY: unlike `/api/v1/poly/wallet/connect`, this route does
 *     NOT go through `getPolyTraderWalletAdapter`. That adapter requires Privy
 *     configuration, which the deployments most in need of a paper account do
 *     not have. Creating one must not depend on live-custody config being
 *     present. (The adapter's paper-mode stub is gone — it now simply throws
 *     `WalletAdapterUnconfiguredError`, and nothing on the paper path calls it.)
 *   - CONSENT_ACTOR_IS_THE_SESSION: `custodial_consent_actor_id` is the session
 *     user's id, never a value from the wire.
 *   - IDEMPOTENT: an existing active paper account is returned with
 *     `created: false` and HTTP 200; re-posting never mints a second account
 *     and never re-seeds a balance that may already have been traded against.
 * Side-effects: IO (DB writes).
 * Links: docs/spec/capability-plane.md, docs/spec/poly-tenant-and-collateral.md,
 *        migration 0082
 * @public
 */

import { toUserId, userActor } from "@cogni/ids";
import {
  type PolyPaperAccountCreateOutput,
  polyPaperAccountCreateOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { provisionPaperAccount } from "@/features/paper-accounts";
import { invalidateDashboardRouteCaches } from "../wallet/_lib/dashboard-route-cache";

export const dynamic = "force-dynamic";

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.paper_account.create",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) throw new Error("sessionUser required");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = polyPaperAccountCreateOperation.input.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const container = getContainer();
    const account = await container
      .accountsForUser(toUserId(sessionUser.id))
      .getOrCreateBillingAccountForUser({ userId: sessionUser.id });

    let result: Awaited<ReturnType<typeof provisionPaperAccount>>;
    try {
      result = await withTenantScope(
        getAppDb(),
        userActor(toUserId(sessionUser.id)),
        (tx) =>
          provisionPaperAccount(tx, {
            billingAccountId: account.id,
            createdByUserId: sessionUser.id,
            actorKind: "user",
            actorId: sessionUser.id,
            seedUsdc: parsed.data.seedUsdc,
            defaultGrant: parsed.data.defaultGrant,
          })
      );
    } catch (err) {
      // The advisory lock in provisionPaperAccount serializes concurrent
      // creates for one tenant, so this should be unreachable. Map it rather
      // than 500 so a genuine race reads as "already exists, retry" instead of
      // an opaque failure.
      if (isUniqueViolation(err)) {
        ctx.log.warn(
          { billing_account_id: account.id, user_id: sessionUser.id },
          "poly.paper_account.create — lost a create race"
        );
        return NextResponse.json(
          { error: "paper_account_already_exists" },
          { status: 409 }
        );
      }
      throw err;
    }

    const payload: PolyPaperAccountCreateOutput = {
      connection_id: result.connectionId,
      kind: "paper",
      address: result.address,
      seed_usdc: result.seedUsdc,
      created: result.created,
      // APPROVALS_PRESTAMPED: provisionPaperAccount sets
      // trading_approvals_ready_at at insert, so a paper account is never
      // stuck behind the APPROVALS_BEFORE_PLACE gate in authorizeIntent.
      trading_ready: true,
    };
    // A no-wallet response may already be cached. Evict it before replying so
    // the creating browser's refetch observes the new paper connection.
    invalidateDashboardRouteCaches(account.id);
    ctx.log.info(
      {
        billing_account_id: account.id,
        user_id: sessionUser.id,
        connection_id: result.connectionId,
        address: result.address,
        seed_usdc: result.seedUsdc,
        created: result.created,
      },
      "poly.paper_account.create — paper trading account ready"
    );
    return NextResponse.json(
      polyPaperAccountCreateOperation.output.parse(payload),
      { status: result.created ? 201 : 200 }
    );
  }
);
