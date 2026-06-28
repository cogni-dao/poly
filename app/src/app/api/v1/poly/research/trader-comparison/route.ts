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
    routeId: "poly.research.trader-comparison",
    auth: { mode: "required", getSessionUser },
  },
  async (_ctx, request) => {
    const url = new URL(request.url);
    return NextResponse.json({
      wallet: url.searchParams.get("wallet"),
      computedAt: capturedAt(),
      traders: [],
      markets: [],
      warnings: [POLY_RUNTIME_BOOTSTRAP_WARNING],
    });
  }
);
