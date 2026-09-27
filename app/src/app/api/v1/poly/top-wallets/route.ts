// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/poly/top-wallets/route`
 * Purpose: Dashboard endpoint for the "Top Wallets" card — returns top Polymarket wallets by PnL for a window.
 * Scope: Validates query via Zod, delegates to WalletCapability. Does not implement business logic.
 * Invariants:
 *   - AUTH_REQUIRED: Internal dashboard endpoint; session user must be present.
 *   - CAPABILITY_NOT_ADAPTER: Route calls WalletCapability; never imports the Data API client directly.
 *   - PAGE_LOAD_DB_ONLY (bug.5017): the capability reads only
 *     `poly_top_wallet_stats`; the Polymarket fan-out lives in the
 *     top-wallet-stats job. Cold start (table not yet populated) returns
 *     200 with an empty `traders` list — never an upstream fallback.
 *   - READ_ONLY: Single bounded SELECT per request.
 * Side-effects: IO (DB read via capability)
 * Links: [createWalletCapability](../../../../../bootstrap/capabilities/wallet.ts), work/items/task.0315, work/items/bug.5017
 * @public
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createWalletCapability } from "@/bootstrap/capabilities/wallet";
import { resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { getServerSessionUser } from "@/lib/auth/server";

// Route-local schema — mirrors WalletTimePeriodSchema / WalletOrderBySchema from
// @cogni/ai-tools. Declared inline because app uses zod 4 while ai-tools is
// built against zod 3, and cross-version `z.infer` loses the enum narrowing.
// Max is 200 to power the /research discovery grid (AI-tool surface stays at 50).
const QuerySchema = z.object({
  timePeriod: z.enum(["DAY", "WEEK", "MONTH", "ALL"]).optional(),
  orderBy: z.enum(["PNL", "VOL"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const dynamic = "force-dynamic";
export const maxDuration = 10; // seconds — generous bound for a single indexed SELECT

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "poly.top-wallets",
    auth: { mode: "required", getSessionUser: getServerSessionUser },
  },
  async (_ctx, request) => {
    const { searchParams } = new URL(request.url);
    const parsed = QuerySchema.safeParse({
      timePeriod: searchParams.get("timePeriod") || undefined,
      orderBy: searchParams.get("orderBy") || undefined,
      limit: searchParams.get("limit") || undefined,
    });

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.format() },
        { status: 400 }
      );
    }

    const db =
      resolveServiceDb() as unknown as import("drizzle-orm/node-postgres").NodePgDatabase<
        Record<string, unknown>
      >;
    const walletCapability = createWalletCapability({ db });
    const result = await walletCapability.listTopTraders({
      timePeriod: parsed.data.timePeriod ?? "WEEK",
      orderBy: parsed.data.orderBy ?? "PNL",
      limit: parsed.data.limit ?? 10,
    });

    return NextResponse.json(result);
  }
);
