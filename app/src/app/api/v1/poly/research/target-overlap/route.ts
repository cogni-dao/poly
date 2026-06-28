// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { capturedAt } from "../../_lib/degraded";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research.target-overlap",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request) => {
    const url = new URL(request.url);
    const interval = url.searchParams.get("interval") ?? "ALL";
    const response = {
      window: interval,
      computedAt: capturedAt(),
      wallets: {
        rn1: { label: "RN1", address: "", observed: false },
        swisstony: { label: "swisstony", address: "", observed: false },
      },
      buckets: [],
    };
    ctx.log.info({ interval }, "poly.research_target_overlap_degraded");
    return NextResponse.json(response);
  }
);
