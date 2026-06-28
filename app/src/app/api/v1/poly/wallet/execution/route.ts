// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { capturedAt, noWalletWarning } from "../../_lib/degraded";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "poly.wallet.execution", auth: { mode: "required", getSessionUser } },
  async (_ctx, request) => {
    const url = new URL(request.url);
    return NextResponse.json({
      configured: false,
      connected: false,
      freshness: url.searchParams.get("freshness") ?? undefined,
      address: null,
      capturedAt: capturedAt(),
      trades_per_day: [],
      live_positions: [],
      closed_positions: [],
      warnings: [noWalletWarning()],
    });
  }
);
