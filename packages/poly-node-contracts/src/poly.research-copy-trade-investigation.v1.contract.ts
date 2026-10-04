// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.research-copy-trade-investigation.v1.contract`
 * Purpose: Bounded, account-scoped saved-facts contract for one copy-trade market investigation.
 * Scope: GET summary and cursor-paginated evidence routes. No writes or upstream reads.
 * Invariants:
 *   - EXPLICIT_ACCOUNT_AND_MARKET: every request names one billing account and one condition.
 *   - CAPABILITY_GATED: callers need owner access or an active `performance:read` grant.
 *   - BOUNDED_EVIDENCE: evidence pages are hard-capped and use opaque keyset cursors.
 *   - SNAPSHOT_CUTOFF: `captured_at` freezes evidence membership across pages.
 *   - SAVED_FACTS_ONLY: every field comes from persisted Postgres facts.
 * Side-effects: none
 * Links: story.5003, .claude/skills/delta-minimizer/SKILL.md
 * @public
 */

import { z } from "zod";

import { PolyResearchCopyTradePnlModeSchema } from "./poly.research-copy-trade-pnl.v1.contract";

const IsoTimestampSchema = z.string().datetime({ offset: true });
const OptionalIsoTimestampSchema = IsoTimestampSchema.optional();

export const POLY_COPY_TRADE_INVESTIGATION_EVIDENCE_DEFAULT_LIMIT = 100;
export const POLY_COPY_TRADE_INVESTIGATION_EVIDENCE_MAX_LIMIT = 200;
export const POLY_COPY_TRADE_INVESTIGATION_MAX_TARGETS = 20;
export const POLY_COPY_TRADE_INVESTIGATION_MAX_LEGS_PER_PARTICIPANT = 2;
export const POLY_COPY_TRADE_INVESTIGATION_MAX_OUTCOMES = 32;

export const PolyResearchCopyTradeInvestigationQuerySchema = z
  .object({
    billing_account_id: z.string().uuid(),
    condition_id: z.string().trim().min(1).max(256),
    mode: PolyResearchCopyTradePnlModeSchema,
    since: OptionalIsoTimestampSchema,
    until: OptionalIsoTimestampSchema,
  })
  .refine(
    (query) =>
      !(query.since && query.until) ||
      Date.parse(query.since) <= Date.parse(query.until),
    {
      message: "`since` must be ≤ `until`",
      path: ["since"],
    }
  );
export type PolyResearchCopyTradeInvestigationQuery = z.infer<
  typeof PolyResearchCopyTradeInvestigationQuerySchema
>;

export const PolyResearchCopyTradeInvestigationEvidenceKindSchema = z.enum([
  "fills",
  "decisions",
]);
export type PolyResearchCopyTradeInvestigationEvidenceKind = z.infer<
  typeof PolyResearchCopyTradeInvestigationEvidenceKindSchema
>;

export const PolyResearchCopyTradeInvestigationEvidenceQuerySchema =
  PolyResearchCopyTradeInvestigationQuerySchema.extend({
    kind: PolyResearchCopyTradeInvestigationEvidenceKindSchema,
    captured_at: IsoTimestampSchema,
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(POLY_COPY_TRADE_INVESTIGATION_EVIDENCE_MAX_LIMIT)
      .default(POLY_COPY_TRADE_INVESTIGATION_EVIDENCE_DEFAULT_LIMIT),
  });
export type PolyResearchCopyTradeInvestigationEvidenceQuery = z.infer<
  typeof PolyResearchCopyTradeInvestigationEvidenceQuerySchema
>;

export const PolyInvestigationMarketSchema = z.object({
  condition_id: z.string(),
  event_title: z.string().nullable(),
  event_slug: z.string().nullable(),
  market_title: z.string().nullable(),
  market_slug: z.string().nullable(),
  end_date: z.string().nullable(),
  metadata_fetched_at: z.string().nullable(),
  outcomes: z
    .array(
      z.object({
        token_id: z.string(),
        label: z.string().nullable(),
        resolution: z.enum(["winner", "loser", "unknown"]),
        payout: z.number().nullable(),
        resolved_at: z.string().nullable(),
        updated_at: z.string(),
      })
    )
    .max(POLY_COPY_TRADE_INVESTIGATION_MAX_OUTCOMES),
});

export const PolyInvestigationObservedLegSchema = z.object({
  token_id: z.string(),
  outcome: z.string().nullable(),
  shares: z.number().nonnegative(),
  cost_basis_usdc: z.number().nonnegative(),
  current_value_usdc: z.number().nonnegative(),
  avg_price: z.number().nonnegative().nullable(),
  lifecycle: z.enum(["active", "inactive"]),
  observed_at: z.string(),
});

export const PolyInvestigationMirrorLegSchema = z.object({
  token_id: z.string(),
  outcome: z.string().nullable(),
  buy_count: z.number().int().nonnegative(),
  sell_count: z.number().int().nonnegative(),
  buy_shares: z.number().nonnegative(),
  sell_shares: z.number().nonnegative(),
  net_shares: z.number(),
  buy_usdc: z.number().nonnegative(),
  sell_usdc: z.number().nonnegative(),
  buy_vwap: z.number().nonnegative().nullable(),
  sell_vwap: z.number().nonnegative().nullable(),
  fees_usdc: z.number().nonnegative(),
  mark_price: z.number().nonnegative().nullable(),
  marked_value_usdc: z.number().nonnegative().nullable(),
  mark_observed_at: z.string().nullable(),
  missing_realized_rows: z.number().int().nonnegative(),
  first_observed_at: z.string().nullable(),
  last_observed_at: z.string().nullable(),
});

export const PolyInvestigationTargetSchema = z.object({
  target_id: z.string().uuid(),
  wallet_address: z.string(),
  label: z.string().nullable(),
  active: z.boolean(),
  policy: z.object({
    kind: z.string(),
    mirror_filter_percentile: z.number().int(),
    mirror_max_usdc_per_trade: z.number().nonnegative(),
    target_range_max_usdc: z.number().nonnegative().nullable(),
    mirror_max_alloc_per_condition_usdc: z.number().nonnegative().nullable(),
    activated_at: z.string(),
  }),
  legs: z
    .array(PolyInvestigationObservedLegSchema)
    .max(POLY_COPY_TRADE_INVESTIGATION_MAX_LEGS_PER_PARTICIPANT),
});

export const PolyInvestigationAggregateSchema = z.object({
  fills: z.object({
    count: z.number().int().nonnegative(),
    placed_count: z.number().int().nonnegative(),
    pending_count: z.number().int().nonnegative(),
    open_count: z.number().int().nonnegative(),
    filled_count: z.number().int().nonnegative(),
    partial_count: z.number().int().nonnegative(),
    canceled_count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    first_observed_at: z.string().nullable(),
    last_observed_at: z.string().nullable(),
  }),
  decisions: z.object({
    count: z.number().int().nonnegative(),
    placed_count: z.number().int().nonnegative(),
    skipped_count: z.number().int().nonnegative(),
    error_count: z.number().int().nonnegative(),
    first_decided_at: z.string().nullable(),
    last_decided_at: z.string().nullable(),
    top_reasons: z
      .array(
        z.object({
          reason: z.string(),
          count: z.number().int().nonnegative(),
        })
      )
      .max(25),
  }),
});

export const PolyInvestigationFactStatusSchema = z.object({
  source: z.enum([
    "mirror_ledger",
    "market_prices",
    "target_positions",
    "market_metadata",
    "market_outcomes",
  ]),
  status: z.enum(["fresh", "stale", "missing", "partial"]),
  observed_at: z.string().nullable(),
  complete: z.boolean(),
});

export const PolyResearchCopyTradeInvestigationResponseSchema = z.object({
  billing_account_id: z.string().uuid(),
  condition_id: z.string(),
  mode: PolyResearchCopyTradePnlModeSchema,
  since: z.string().nullable(),
  until: z.string().nullable(),
  captured_at: z.string(),
  association_sources: z
    .array(z.enum(["fill", "decision", "target_position"]))
    .min(1),
  market: PolyInvestigationMarketSchema,
  account_position: z.object({
    source: z.literal("mirror_execution_ledger"),
    legs: z.array(PolyInvestigationMirrorLegSchema).max(4),
  }),
  targets: z
    .array(PolyInvestigationTargetSchema)
    .max(POLY_COPY_TRADE_INVESTIGATION_MAX_TARGETS),
  aggregates: PolyInvestigationAggregateSchema,
  completeness: z.object({
    complete: z.boolean(),
    targets_truncated: z.boolean(),
    facts: z.array(PolyInvestigationFactStatusSchema),
  }),
});
export type PolyResearchCopyTradeInvestigationResponse = z.infer<
  typeof PolyResearchCopyTradeInvestigationResponseSchema
>;

export const PolyInvestigationFillEvidenceSchema = z.object({
  kind: z.literal("fill"),
  evidence_id: z.string(),
  occurred_at: z.string(),
  target_id: z.string().uuid(),
  target_wallet: z.string().nullable(),
  fill_id: z.string(),
  token_id: z.string().nullable(),
  side: z.enum(["BUY", "SELL"]).nullable(),
  status: z.string(),
  price: z.number().nonnegative().nullable(),
  shares: z.number().nonnegative().nullable(),
  fees_usdc: z.number().nonnegative().nullable(),
  intent_size_usdc: z.number().nonnegative().nullable(),
  filled_size_usdc: z.number().nonnegative().nullable(),
  position_lifecycle: z.string().nullable(),
});

export const PolyInvestigationDecisionEvidenceSchema = z.object({
  kind: z.literal("decision"),
  evidence_id: z.string().uuid(),
  occurred_at: z.string(),
  target_id: z.string().uuid(),
  target_wallet: z.string().nullable(),
  fill_id: z.string(),
  outcome: z.enum(["placed", "skipped", "error"]),
  reason: z.string().nullable(),
  token_id: z.string().nullable(),
  side: z.enum(["BUY", "SELL"]).nullable(),
  limit_price: z.number().nonnegative().nullable(),
  size_usdc: z.number().nonnegative().nullable(),
  position_branch: z.string().nullable(),
  target_position_usdc: z.number().nonnegative().nullable(),
  target_hedge_ratio: z.number().nonnegative().nullable(),
});

export const PolyResearchCopyTradeInvestigationEvidenceResponseSchema =
  z.object({
    billing_account_id: z.string().uuid(),
    condition_id: z.string(),
    mode: PolyResearchCopyTradePnlModeSchema,
    kind: PolyResearchCopyTradeInvestigationEvidenceKindSchema,
    since: z.string().nullable(),
    until: z.string().nullable(),
    captured_at: z.string(),
    limit: z.number().int().positive(),
    items: z.array(
      z.discriminatedUnion("kind", [
        PolyInvestigationFillEvidenceSchema,
        PolyInvestigationDecisionEvidenceSchema,
      ])
    ),
    next_cursor: z.string().nullable(),
    truncated: z.boolean(),
  });
export type PolyResearchCopyTradeInvestigationEvidenceResponse = z.infer<
  typeof PolyResearchCopyTradeInvestigationEvidenceResponseSchema
>;

export const polyResearchCopyTradeInvestigationOperation = {
  id: "poly.research-copy-trade-investigation.v1",
  summary: "Bounded saved-facts snapshot for one authorized copy-trade market",
  input: PolyResearchCopyTradeInvestigationQuerySchema,
  output: PolyResearchCopyTradeInvestigationResponseSchema,
} as const;

export const polyResearchCopyTradeInvestigationEvidenceOperation = {
  id: "poly.research-copy-trade-investigation-evidence.v1",
  summary: "Cursor-paginated decision or fill evidence for one authorized market",
  input: PolyResearchCopyTradeInvestigationEvidenceQuerySchema,
  output: PolyResearchCopyTradeInvestigationEvidenceResponseSchema,
} as const;
