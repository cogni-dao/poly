// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.research-copy-trade-pnl.v1.contract`
 * Purpose: Per-tenant mirror-execution rollup from `poly_copy_trade_fills`, by market.
 *          Enables a trust-twin (preview, mode=paper) vs PROD-Derek (mode=live) diff
 *          on positions + sized exposure without exposing per-row PII.
 * Scope: GET /api/v1/poly/research/copy-trade-pnl; does not mutate state or fan out upstream.
 *   Read-only, session-authed, tenant id provided as a query param
 *   (cross-tenant inspection — single-deploy v0).
 * Invariants:
 *   - SQL_AGGREGATION_ONLY: every metric returned is a Postgres aggregate. No V8 reduce.
 *     (per `data-research` skill — bug.5012 lineage)
 *   - PAGE_LOAD_DB_ONLY: no upstream calls during render; reads `poly_copy_trade_fills`.
 *   - TENANT_PARAM_EXPLICIT: billing_account_id is a required query arg, not session-derived,
 *     so a diff script can compare two tenants in one process. Auth is "any session user".
 *   - WINDOW_ON_OBSERVED_AT: `since` / `until` filter `poly_copy_trade_fills.observed_at`
 *     (when the fill was seen on the target chain log), not `created_at` (when our
 *     mirror row was inserted). Trust-twin comparison wants the time of the real-world
 *     event, not our reaction time.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md, work/projects/proj.poly-paper-trading.md
 * @public
 */

import { z } from "zod";

export const PolyResearchCopyTradePnlModeSchema = z
  .enum(["live", "paper", "all"])
  .default("all");
export type PolyResearchCopyTradePnlMode = z.infer<
  typeof PolyResearchCopyTradePnlModeSchema
>;

// ISO-8601 timestamp; empty / missing treated as no bound.
const IsoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .optional();

export const PolyResearchCopyTradePnlQuerySchema = z
  .object({
    billing_account_id: z.string().uuid(),
    mode: PolyResearchCopyTradePnlModeSchema,
    since: IsoTimestampSchema,
    until: IsoTimestampSchema,
  })
  .refine(
    (q) => !(q.since && q.until) || q.since <= q.until,
    {
      message: "`since` must be ≤ `until`",
      path: ["since"],
    }
  );
export type PolyResearchCopyTradePnlQuery = z.infer<
  typeof PolyResearchCopyTradePnlQuerySchema
>;

export const PolyResearchCopyTradePnlMarketRowSchema = z.object({
  market_id: z.string(),
  target_id: z.string().uuid(),
  target_wallet: z.string().nullable(),
  fills_count: z.number().int().nonnegative(),
  filled_count: z.number().int().nonnegative(),
  open_count: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  canceled_count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  buy_count: z.number().int().nonnegative(),
  sell_count: z.number().int().nonnegative(),
  intent_usdc: z.number().nonnegative(),
  realized_size_usdc: z.number().nonnegative(),
  has_open_position: z.boolean(),
  position_lifecycle: z.string().nullable(),
  first_fill_at: z.string().nullable(),
  last_fill_at: z.string().nullable(),
});
export type PolyResearchCopyTradePnlMarketRow = z.infer<
  typeof PolyResearchCopyTradePnlMarketRowSchema
>;

export const PolyResearchCopyTradePnlSummarySchema = z.object({
  fills_count: z.number().int().nonnegative(),
  filled_count: z.number().int().nonnegative(),
  open_count: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  canceled_count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  markets_count: z.number().int().nonnegative(),
  markets_with_open_position: z.number().int().nonnegative(),
  total_intent_usdc: z.number().nonnegative(),
  total_realized_size_usdc: z.number().nonnegative(),
  first_fill_at: z.string().nullable(),
  last_fill_at: z.string().nullable(),
});
export type PolyResearchCopyTradePnlSummary = z.infer<
  typeof PolyResearchCopyTradePnlSummarySchema
>;

export const PolyResearchCopyTradePnlResponseSchema = z.object({
  billing_account_id: z.string().uuid(),
  mode: PolyResearchCopyTradePnlModeSchema,
  since: z.string().nullable(),
  until: z.string().nullable(),
  captured_at: z.string(),
  summary: PolyResearchCopyTradePnlSummarySchema,
  markets: z.array(PolyResearchCopyTradePnlMarketRowSchema),
});
export type PolyResearchCopyTradePnlResponse = z.infer<
  typeof PolyResearchCopyTradePnlResponseSchema
>;

export const polyResearchCopyTradePnlOperation = {
  id: "poly.research-copy-trade-pnl.v1",
  summary:
    "Per-tenant mirror-execution rollup from poly_copy_trade_fills, grouped by (target, market)",
  description:
    "SQL-aggregated per-market view of a tenant's copy-trade fills. Used to compare a preview paper-twin's positions + sized exposure against the same tenant pattern in PROD live mode. Realized $-PnL via market outcomes joins is a follow-up.",
  input: PolyResearchCopyTradePnlQuerySchema,
  output: PolyResearchCopyTradePnlResponseSchema,
} as const;
