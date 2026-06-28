// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/internal/sync-health/route`
 * Purpose: Read-only Poly sync health endpoint.
 * Scope: Authenticated aggregate health route. Does not query user data or mutate state.
 * Invariants: READ_ONLY_BOOTSTRAP, NO_TRADING_SIDE_EFFECTS.
 * Side-effects: HTTP response only.
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.internal.sync-health",
    auth: { mode: "required", getSessionUser },
  },
  async () => {
    return NextResponse.json({
      oldest_synced_row_age_ms: null,
      rows_stale_over_60s: 0,
      rows_never_synced: 0,
      reconciler_last_tick_at: null,
    });
  }
);
