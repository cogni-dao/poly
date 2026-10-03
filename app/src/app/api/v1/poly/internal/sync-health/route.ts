// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/internal/sync-health`
 * Purpose: HTTP GET — aggregate sync-freshness stats for the order reconciler. Suitable for a Grafana alert rule and a dashboard freshness banner.
 * Scope: No auth — aggregate-only, no PII, no wallet addresses.
 * Invariants:
 *   - SYNC_HEALTH_IS_PUBLIC — response is Zod-validated against PolySyncHealthResponseSchema before returning.
 *   - No user scoping — this endpoint is internal metrics only.
 *   - NO_AUTH_INTENTIONAL — this route intentionally has no authentication. It returns aggregate-only
 *     stats (counts + timestamps), no PII or wallet addresses. Auth was reviewed and deferred
 *     (task.0328 rev1 — follow-up slice may add internal token if threat model changes).
 * Side-effects: IO (two DB SELECTs via the service-role client).
 * Notes: reconciler_last_tick_at is the latest durable `synced_at` written by
 *   the reconciler after a typed CLOB response. It is null when no ledger row
 *   has ever completed reconciliation.
 * Links: work/items/task.0328.md, docs/spec/poly-copy-trade-execution.md
 * @public
 */

import { PolySyncHealthResponseSchema } from "@cogni/poly-node-contracts";
import { polyCopyTradeFills } from "@cogni/poly-db-schema/copy-trade";
import { max } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.internal.sync_health",
    auth: { mode: "none" },
  },
  async (ctx) => {
    try {
      const container = getContainer();
      const [summary, activityRows] = await Promise.all([
        container.orderLedger.syncHealthSummary(),
        container.serviceDb
          .select({
            reconcilerLastTickAt: max(polyCopyTradeFills.syncedAt),
          })
          .from(polyCopyTradeFills),
      ]);
      const reconcilerLastTickAt = activityRows[0]?.reconcilerLastTickAt ?? null;

      const body = PolySyncHealthResponseSchema.parse({
        ...summary,
        reconciler_last_tick_at: reconcilerLastTickAt?.toISOString() ?? null,
      });

      return NextResponse.json(body);
    } catch (err: unknown) {
      ctx.log.error(
        { event: "sync_health_error", err: String(err) },
        "sync-health query failed"
      );
      return NextResponse.json({ error: "sync_health_error" }, { status: 500 });
    }
  }
);
