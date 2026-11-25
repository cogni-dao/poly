// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.research-trader-pnl.v1.contract`
 * Purpose: Contract for the Research page's Trader P/L overlay — the saved Polymarket-native
 *   P/L series for up to three wallets, nothing else.
 * Scope: GET /api/v1/poly/research/trader-pnl. Read-only, session-authenticated, capped to
 *   three wallets. Deliberately SEPARATE from trader-comparison (bug.5065): the overlay only
 *   needs the P/L series, and coupling it to the fill-scanning trade-size aggregate made a
 *   wallet's already-available P/L vanish whenever that aggregate lost its time budget.
 * Invariants:
 *   - COMPARISON_SIZE_CAPPED: max three wallets per request.
 *   - PNL_SINGLE_SOURCE: points come from `poly_trader_user_pnl_points` (the user-pnl read model).
 *   - BOUNDED_POINTS: every series is server-downsampled to at most `TRADER_PNL_MAX_POINTS`.
 *   - NEVER_SILENTLY_DROP: every requested wallet appears in `traders` (possibly with an empty
 *     history) and an unavailable/stale series carries a per-wallet warning.
 * Side-effects: none
 * Links: work/items/bug.5065
 * @public
 */

import { z } from "zod";
import {
  PolyWalletOverviewIntervalSchema,
  PolyWalletOverviewPnlPointSchema,
} from "./poly.wallet.overview.v1.contract";
import { PolyAddressSchema } from "./poly.wallet-analysis.v1.contract";

/** Upper bound on points per trader series after server-side downsampling. */
export const TRADER_PNL_MAX_POINTS = 240;

export const PolyResearchTraderPnlQuerySchema = z.object({
  wallet: z.array(PolyAddressSchema).min(1).max(3),
  label: z.array(z.string().trim().min(1).max(32)).max(3).default([]),
  interval: PolyWalletOverviewIntervalSchema.optional().default("1W"),
});
export type PolyResearchTraderPnlQuery = z.infer<
  typeof PolyResearchTraderPnlQuerySchema
>;

export const PolyResearchTraderPnlWarningSchema = z.object({
  wallet: PolyAddressSchema.optional(),
  code: z.string(),
  message: z.string(),
});
export type PolyResearchTraderPnlWarning = z.infer<
  typeof PolyResearchTraderPnlWarningSchema
>;

export const PolyResearchTraderPnlTraderSchema = z.object({
  address: PolyAddressSchema,
  label: z.string(),
  interval: PolyWalletOverviewIntervalSchema,
  pnl: z.object({
    /** Windowed delta (last - first point); null with fewer than two points. */
    usdc: z.number().nullable(),
    history: z
      .array(PolyWalletOverviewPnlPointSchema)
      .max(TRADER_PNL_MAX_POINTS),
  }),
});
export type PolyResearchTraderPnlTrader = z.infer<
  typeof PolyResearchTraderPnlTraderSchema
>;

export const PolyResearchTraderPnlResponseSchema = z.object({
  interval: PolyWalletOverviewIntervalSchema,
  capturedAt: z.string(),
  traders: z.array(PolyResearchTraderPnlTraderSchema).max(3),
  warnings: z.array(PolyResearchTraderPnlWarningSchema),
});
export type PolyResearchTraderPnlResponse = z.infer<
  typeof PolyResearchTraderPnlResponseSchema
>;

export const polyResearchTraderPnlOperation = {
  id: "poly.research-trader-pnl.v1",
  summary: "Saved P/L series for up to three Polymarket traders",
  description:
    "Research P/L overlay read. One bounded indexed read of poly_trader_user_pnl_points for up to three wallets, downsampled server-side; every requested wallet is returned, with a per-wallet warning when its series is unavailable or stale.",
  input: PolyResearchTraderPnlQuerySchema,
  output: PolyResearchTraderPnlResponseSchema,
} as const;
