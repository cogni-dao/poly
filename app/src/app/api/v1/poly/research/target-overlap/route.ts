// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/research/target-overlap`
 * Purpose: HTTP GET — RN1/swisstony shared-vs-solo active-market overlap.
 * Scope: Thin route. Validates query/output with the poly research overlap
 * contract and delegates aggregation to the wallet-analysis feature service.
 * Invariants:
 *   - AUTH_REQUIRED: research surface is protected.
 *   - SAVED_FACTS_ONLY: reads Postgres observed trader facts; no live upstream
 *     Polymarket calls on page load.
 *   - DB_CAPACITY_IS_503 (bug.5064): a Postgres connection-capacity failure
 *     (53300) returns 503 + Retry-After with a structured warn, never an
 *     unlogged 500; the failure is not cached (FAILED_FETCH_NOT_CACHED).
 *   - SWR_CACHED_INTERIM (2026-09-28): the overlap aggregate scans the full
 *     fills history (25.0s measured on prod) and is served through the
 *     serve-stale-while-revalidate cache in `research-read-cache.ts`
 *     (5min fresh / 60min serve-stale, keyed per interval). Staleness is
 *     acceptable — this is a research aggregate over observed history. The
 *     real fix is tick-written rollup tables (separate design).
 * Side-effects: DB reads only.
 * Links: https://github.com/cogni-dao/cogni/blob/2321821e61dd12aa0cf75d235bd668ff65739109/docs/spec/poly-copy-trade-execution.md, work/items/task.5005
 * @public
 */

import {
  PolyResearchTargetOverlapQuerySchema,
  PolyResearchTargetOverlapResponseSchema,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceReadDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getTargetOverlapSliceCached } from "@/features/wallet-analysis/server/research-read-cache";
import {
  isDbCapacityError,
  sliceFailureFields,
} from "@/features/wallet-analysis/server/slice-failure";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research.target-overlap",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request) => {
    const url = new URL(request.url);
    const parsed = PolyResearchTargetOverlapQuerySchema.safeParse({
      interval: url.searchParams.get("interval") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_query", message: parsed.error.message },
        { status: 400 }
      );
    }
    const db =
      resolveServiceReadDb() as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
        Record<string, unknown>
      >;
    try {
      const overlap = await getTargetOverlapSliceCached(
        db,
        parsed.data.interval
      );
      return NextResponse.json(
        PolyResearchTargetOverlapResponseSchema.parse(overlap)
      );
    } catch (err) {
      // bug.5064: Postgres refusing a connection (SQLSTATE 53300) is transient
      // capacity, not a server bug — answer 503 + Retry-After and log the cause
      // code instead of an opaque 500. Anything else keeps the wrapper's 500.
      if (!isDbCapacityError(err)) throw err;
      ctx.log.warn(
        {
          ...sliceFailureFields("target_overlap", err),
          event: EVENT_NAMES.POLY_RESEARCH_DB_CAPACITY_UNAVAILABLE,
        },
        "target-overlap read refused: database connection capacity"
      );
      return NextResponse.json(
        { error: "db_capacity_unavailable", retryable: true },
        { status: 503, headers: { "Retry-After": "5" } }
      );
    }
  }
);
