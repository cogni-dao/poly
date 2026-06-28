// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "poly.wallet.balance", auth: { mode: "required", getSessionUser } },
  async () => {
    return NextResponse.json(
      {
        error: "deprecated_endpoint",
        message: "Use /api/v1/poly/wallet/balances for tenant wallet balances.",
      },
      { status: 410 }
    );
  }
);

