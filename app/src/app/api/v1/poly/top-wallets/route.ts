// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/top-wallets/route`
 * Purpose: Safe read-only placeholder for Poly top-wallet research.
 * Scope: Authenticated degraded response. Does not call upstream markets in the bootstrap slice.
 * Invariants: READ_ONLY_BOOTSTRAP, NO_TRADING_SIDE_EFFECTS.
 * Side-effects: HTTP response only.
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { capturedAt, POLY_RUNTIME_BOOTSTRAP_WARNING } from "../_lib/degraded";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "poly.top-wallets", auth: { mode: "required", getSessionUser } },
  async (ctx, request) => {
    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get("limit") ?? 25);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100)
      : 25;

    ctx.log.info({ limit }, "poly.top_wallets_degraded");

    return NextResponse.json({
      wallets: [],
      limit,
      capturedAt: capturedAt(),
      warnings: [POLY_RUNTIME_BOOTSTRAP_WARNING],
    });
  }
);
