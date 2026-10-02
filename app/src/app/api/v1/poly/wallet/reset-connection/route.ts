// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallet/reset-connection`
 * Purpose: Let an authenticated owner safely reset their own empty, idle
 *   Polymarket wallet connection before normal UI reprovisioning.
 * Scope: Auth, contract mapping, tenant derivation, and feature invocation.
 * Invariants:
 *   - TENANT_FROM_SESSION: no tenant identifier crosses the wire.
 *   - NO_FUND_MOVEMENT: the feature only revokes; it never transfers assets.
 *   - FAIL_CLOSED: unreadable balances, funds, positions, orders, or active
 *     copy targets prevent an immediate revoke.
 * Side-effects: Delegates tenant-scoped DB and Polygon reads plus revoke.
 * Links: docs/spec/poly-tenant-and-collateral.md, task.5167
 * @public
 */

import { toUserId, userActor } from "@cogni/ids";
import {
  type PolyWalletResetConnectionOutput,
  polyWalletResetConnectionOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  checkConnectRateLimit,
  createPolyWalletResetStateAdapter,
  getPolyTraderWalletAdapter,
  WalletAdapterUnconfiguredError,
} from "@/bootstrap/poly-trader-wallet";
import { resetWalletConnection } from "@/features/wallet-recovery/reset-wallet-connection";
import { EVENT_NAMES, logEvent } from "@/shared/observability";
import { resolveBillingAccountId } from "../../_lib/billing-account-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function parseBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.wallet.reset_connection",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    if (!sessionUser) throw new Error("sessionUser required");
    const parsed = polyWalletResetConnectionOperation.input.safeParse(
      await parseBody(request)
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_reset_request" },
        { status: 400 }
      );
    }

    const startedAt = performance.now();
    const container = getContainer();
    const billingAccountId = await resolveBillingAccountId(
      container.serviceAccountService,
      sessionUser.id
    );

    let wallet: ReturnType<typeof getPolyTraderWalletAdapter>;
    try {
      wallet = getPolyTraderWalletAdapter(ctx.log);
    } catch (error) {
      if (error instanceof WalletAdapterUnconfiguredError) {
        return NextResponse.json(
          { error: "wallet_adapter_unconfigured" },
          { status: 503 }
        );
      }
      throw error;
    }

    const result = await resetWalletConnection(
      {
        state: createPolyWalletResetStateAdapter(),
        wallet,
        getReprovisionWaitSeconds: async (accountId) =>
          (await checkConnectRateLimit(accountId)).retryAfterSeconds,
        now: () => new Date(),
      },
      {
        actorId: userActor(toUserId(sessionUser.id)),
        userId: sessionUser.id,
        billingAccountId,
      }
    );

    if (result.outcome === "reset") {
      container.invalidatePolyTradeExecutorFor(billingAccountId);
    }

    const payload: PolyWalletResetConnectionOutput = {
      billing_account_id: result.billingAccountId,
      outcome: result.outcome,
      blocked_reason: result.blockedReason,
      connection: result.connection
        ? {
            connection_id: result.connection.connectionId,
            funder_address: result.connection.funderAddress,
            signer_address: result.connection.signerAddress,
            revoked_at: result.connection.revokedAt?.toISOString() ?? null,
          }
        : null,
      balances: {
        usdc_e: result.balances.usdcE,
        pusd: result.balances.pusd,
        pol: result.balances.pol,
        read_errors: [...result.balances.readErrors],
      },
      unsettled_fill_count: result.unsettledOrderCount,
      open_position_count: result.openPositionCount,
      grants_revoked_count: result.grantsRevokedCount,
      targets_disabled_count: result.targetsDisabledCount,
      reprovision_available_in_seconds:
        result.reprovisionAvailableInSeconds,
    };
    const status = result.outcome === "blocked" ? 409 : 200;

    logEvent(ctx.log, EVENT_NAMES.POLY_WALLET_RESET_CONNECTION_COMPLETE, {
      reqId: ctx.reqId,
      routeId: ctx.routeId,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      outcome: result.outcome === "reset" ? "success" : "skipped",
      billing_account_id: billingAccountId,
      user_id: sessionUser.id,
      reset_outcome: result.outcome,
      ...(result.blockedReason ? { errorCode: result.blockedReason } : {}),
      unsettled_fill_count: result.unsettledOrderCount,
      open_position_count: result.openPositionCount,
      grants_revoked_count: result.grantsRevokedCount,
      targets_disabled_count: result.targetsDisabledCount,
    });

    return NextResponse.json(
      polyWalletResetConnectionOperation.output.parse(payload),
      { status }
    );
  }
);
