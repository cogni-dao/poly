// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { capturedAt, noWalletWarning } from "../../_lib/degraded";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "poly.wallet.overview", auth: { mode: "required", getSessionUser } },
  async (_ctx, request) => {
    const url = new URL(request.url);
    return NextResponse.json({
      configured: false,
      connected: false,
      freshness: url.searchParams.get("freshness") ?? undefined,
      address: null,
      interval: url.searchParams.get("interval") ?? "1D",
      capturedAt: capturedAt(),
      pol_gas: null,
      usdc_available: null,
      usdc_locked: null,
      usdc_positions_mtm: null,
      usdc_total: null,
      open_orders: null,
      positions_synced_at: null,
      positions_sync_age_ms: null,
      positions_stale: false,
      pnlHistory: [],
      warnings: [noWalletWarning()],
    });
  }
);
