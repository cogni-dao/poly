// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/research/trader-pnl/route`
 * Purpose: HTTP GET for the Research page's Trader P/L overlay.
 * Scope: Thin handler. Auth via getSessionUser, Zod query validation, ONE bounded DB read via
 *   the feature service, response validation.
 * Invariants:
 *   - AUTH_REQUIRED: research surface is protected.
 *   - PAGE_LOAD_DB_ONLY: reads the saved user-pnl read model; no upstream Polymarket call.
 *   - NEVER_SILENTLY_DROP: every requested wallet is in the response; unavailable/stale series
 *     carry per-wallet warnings on a 200 (bug.5065).
 *   - DB_CAPACITY_IS_503 (bug.5064): a Postgres connection-capacity failure (53300) answers
 *     503 + Retry-After with a structured warn, never an unlogged 500.
 *   - NOT_COUPLED_TO_FILL_AGGREGATES: independent of trader-comparison's fill scans and its
 *     8s wallet budget, which previously dropped traders whose P/L was already available.
 * Side-effects: DB reads only.
 * Links: packages/poly-node-contracts/src/poly.research-trader-pnl.v1.contract.ts, work/items/bug.5065
 * @public
 */

import {
  PolyResearchTraderPnlQuerySchema,
  PolyResearchTraderPnlResponseSchema,
} from "@cogni/poly-node-contracts";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveServiceReadDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  isDbCapacityError,
  sliceFailureFields,
} from "@/features/wallet-analysis/server/slice-failure";
import { getTraderPnl } from "@/features/wallet-analysis/server/trader-pnl-service";
import { EVENT_NAMES } from "@/shared/observability";

export const dynamic = "force-dynamic";

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.research-trader-pnl",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request) => {
    const url = new URL(request.url);
    const parsed = PolyResearchTraderPnlQuerySchema.safeParse({
      wallet: url.searchParams.getAll("wallet"),
      label: url.searchParams.getAll("label"),
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
      const response = await getTraderPnl(
        db,
        parsed.data.wallet.map((address, index) => ({
          address,
          label: parsed.data.label[index],
        })),
        parsed.data.interval
      );
      return NextResponse.json(
        PolyResearchTraderPnlResponseSchema.parse(response)
      );
    } catch (err) {
      if (!isDbCapacityError(err)) throw err;
      ctx.log.warn(
        {
          ...sliceFailureFields("trader_pnl", err),
          event: EVENT_NAMES.POLY_RESEARCH_DB_CAPACITY_UNAVAILABLE,
        },
        "trader-pnl read refused: database connection capacity"
      );
      return NextResponse.json(
        { error: "db_capacity_unavailable", retryable: true },
        { status: 503, headers: { "Retry-After": "5" } }
      );
    }
  }
);
