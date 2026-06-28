// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { capturedAt, POLY_RUNTIME_BOOTSTRAP_WARNING } from "../../_lib/degraded";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research.copy-trade-pnl",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request) => {
    const url = new URL(request.url);
    return NextResponse.json({
      billing_account_id: url.searchParams.get("billing_account_id"),
      mode: url.searchParams.get("mode") ?? "live",
      since: url.searchParams.get("since"),
      until: url.searchParams.get("until"),
      captured_at: capturedAt(),
      summary: {
        fills_count: 0,
        markets_count: 0,
        total_size_usdc: 0,
        realized_pnl_usdc: null,
      },
      markets: [],
      warnings: [POLY_RUNTIME_BOOTSTRAP_WARNING],
    });
  }
);
