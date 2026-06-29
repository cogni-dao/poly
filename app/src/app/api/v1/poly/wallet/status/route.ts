// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { toUserId } from "@cogni/ids";
import {
  type PolyWalletStatusOutput,
  polyWalletStatusOperation,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  getPolyTraderWalletAdapter,
  WalletAdapterUnconfiguredError,
} from "@/bootstrap/poly-trader-wallet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "poly.wallet.status", auth: { mode: "required", getSessionUser } },
  async (ctx, _request, sessionUser) => {
    if (!sessionUser) throw new Error("sessionUser required");

    const container = getContainer();
    const account = await container
      .accountsForUser(toUserId(sessionUser.id))
      .getOrCreateBillingAccountForUser({ userId: sessionUser.id });

    let adapter: ReturnType<typeof getPolyTraderWalletAdapter>;
    try {
      adapter = getPolyTraderWalletAdapter(ctx.log);
    } catch (err) {
      if (err instanceof WalletAdapterUnconfiguredError) {
        const payload: PolyWalletStatusOutput = {
          configured: false,
          connected: false,
          connection_id: null,
          funder_address: null,
          trading_ready: false,
          auto_wrap_consent_at: null,
          auto_wrap_floor_usdce_atomic: null,
        };
        return NextResponse.json(
          polyWalletStatusOperation.output.parse(payload)
        );
      }
      throw err;
    }

    const summary = await adapter.getConnectionSummary(account.id);
    const payload: PolyWalletStatusOutput = summary
      ? {
          configured: true,
          connected: true,
          connection_id: summary.connectionId,
          funder_address: summary.funderAddress,
          trading_ready: summary.tradingApprovalsReadyAt !== null,
          auto_wrap_consent_at:
            summary.autoWrapConsentAt?.toISOString() ?? null,
          auto_wrap_floor_usdce_atomic:
            summary.autoWrapFloorUsdceAtomic.toString(),
        }
      : {
          configured: true,
          connected: false,
          connection_id: null,
          funder_address: null,
          trading_ready: false,
          auto_wrap_consent_at: null,
          auto_wrap_floor_usdce_atomic: null,
        };

    return NextResponse.json(polyWalletStatusOperation.output.parse(payload));
  }
);
