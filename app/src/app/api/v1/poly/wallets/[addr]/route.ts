// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/wallets/[addr]/route`
 * Purpose: Safe read-only placeholder for a Poly wallet research profile.
 * Scope: Authenticated degraded response. Does not call upstream APIs or mutate state.
 * Invariants: READ_ONLY_BOOTSTRAP, NO_TRADING_SIDE_EFFECTS.
 * Side-effects: HTTP response only.
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { capturedAt, POLY_RUNTIME_BOOTSTRAP_WARNING } from "../../_lib/degraded";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

export const GET = wrapRouteHandlerWithLogging<{
  params: Promise<{ addr: string }>;
}>(
  { routeId: "poly.wallet-profile", auth: { mode: "required", getSessionUser } },
  async (_ctx, request, _sessionUser, context) => {
    if (!context) throw new Error("context required for dynamic routes");
    const { addr } = await context.params;

    if (!WALLET_RE.test(addr)) {
      return NextResponse.json(
        { error: "invalid_address", address: addr },
        { status: 400 }
      );
    }

    const url = new URL(request.url);
    return NextResponse.json({
      address: addr,
      include: url.searchParams.get("include") ?? null,
      snapshot: null,
      positions: [],
      trades: [],
      capturedAt: capturedAt(),
      warnings: [POLY_RUNTIME_BOOTSTRAP_WARNING],
    });
  }
);
