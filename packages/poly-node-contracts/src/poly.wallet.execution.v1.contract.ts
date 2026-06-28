// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/poly.wallet.execution.v1.contract`
 * Purpose: Defines the trading-wallet execution route contract for the dashboard trade-cadence chart and positions view.
 * Scope: GET /api/v1/poly/wallet/execution. Read-only; session-authenticated; does not mutate wallet state or infer wallet totals.
 * Invariants:
 *   - Address is always the configured tenant wallet (or zero-address when unconfigured).
 *   - Position timelines are price-series traces, not fabricated balance curves.
 *   - Market links must come from upstream slugs, never title guessing.
 *   - live_positions contains open/redeemable rows only; closed_positions contains closed rows only.
 *   - lifecycleState (optional) reflects the redeem-pipeline classification (task.0388). Drives Open vs History tab membership and the Redeem-button gate; absent / null when the pipeline has not yet classified the position.
 * Side-effects: none
 * Links: docs/spec/poly-copy-trade-execution.md, docs/design/wallet-analysis-components.md
 * @public
 */

import { z } from "zod";
import { PolyWalletDataFreshnessSchema } from "./poly.wallet.overview.v1.contract";
import { PolyAddressSchema } from "./poly.wallet-analysis.v1.contract";

export const WalletExecutionPositionStatusSchema = z.enum([
  "open",
  "closed",
  "redeemable",
]);
export type WalletExecutionPositionStatus = z.infer<
  typeof WalletExecutionPositionStatusSchema
>;

/**
 * Lifecycle state from the redeem pipeline (`poly_redeem_jobs`). Drives the
 * dashboard's Open vs History tab membership and the Redeem-button gate.
 * `null` when the pipeline has not classified the position yet.
 */
export const WalletExecutionLifecycleStateSchema = z.enum([
  "unresolved",
  "open",
  "closing",
  "closed",
  "resolving",
  "winner",
  "redeem_pending",
  "redeemed",
  "loser",
  "dust",
  "abandoned",
]);
export type WalletExecutionLifecycleState = z.infer<
  typeof WalletExecutionLifecycleStateSchema
>;
/**
 * Lifecycle states that mean the underlying *position* is gone — tokens
 * burned (`redeemed`), worthless (`loser`), too small to matter (`dust`),
 * or explicitly closed by the operator (`closed`). Dashboard zeros
 * `currentValue` only for these.
 *
 * Notably absent: `abandoned`. That means the redeem-job pipeline gave up
 * on a specific tx flow (e.g. 3 transient submission failures) — the
 * SHARES ARE STILL ON CHAIN. Treating abandoned as terminal hid real
 * winnings on the dashboard whenever `redeemPositions` reverted in a way
 * the worker couldn't auto-recover from. (bug.5040 follow-up)
 *
 * Position state derives from chain truth — `marketOutcome` from
 * `poly_market_outcomes.payoutNumerator` — not from job pipeline state.
 */
export const WALLET_EXECUTION_TERMINAL_LIFECYCLE_STATES: ReadonlySet<WalletExecutionLifecycleState> =
  new Set<WalletExecutionLifecycleState>([
    "closed",
    "redeemed",
    "loser",
    "dust",
  ]);

export const WalletExecutionTimelinePointSchema = z.object({
  ts: z.string(),
  price: z.number().min(0),
  size: z.number().nonnegative(),
});
export type WalletExecutionTimelinePoint = z.infer<
  typeof WalletExecutionTimelinePointSchema
>;

export const WalletExecutionEventKindSchema = z.enum([
  "entry",
  "add",
  "reduce",
  "close",
  "redeemable",
]);
export type WalletExecutionEventKind = z.infer<
  typeof WalletExecutionEventKindSchema
>;

export const WalletExecutionEventSchema = z.object({
  ts: z.string(),
  kind: WalletExecutionEventKindSchema,
  price: z.number().min(0),
  shares: z.number().nonnegative(),
});
export type WalletExecutionEvent = z.infer<typeof WalletExecutionEventSchema>;

export const WalletExecutionPositionSchema = z.object({
  positionId: z.string(),
  conditionId: z.string(),
  asset: z.string(),
  marketTitle: z.string(),
  eventTitle: z.string().nullable().optional(),
  marketSlug: z.string().nullable(),
  eventSlug: z.string().nullable(),
  marketUrl: z.string().url().nullable(),
  outcome: z.string(),
  status: WalletExecutionPositionStatusSchema,
  lifecycleState: WalletExecutionLifecycleStateSchema.nullable().optional(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  resolvesAt: z.string().nullable(),
  gameStartTime: z.string().nullable().optional(),
  heldMinutes: z.number().int().nonnegative(),
  entryPrice: z.number().min(0),
  currentPrice: z.number().min(0),
  size: z.number().nonnegative(),
  currentValue: z.number().nonnegative(),
  pnlUsd: z.number(),
  pnlPct: z.number(),
  syncedAt: z.string().nullable().optional(),
  syncAgeMs: z.number().int().nonnegative().nullable().optional(),
  syncStale: z.boolean().optional(),
  timeline: z.array(WalletExecutionTimelinePointSchema),
  events: z.array(WalletExecutionEventSchema),
});
export type WalletExecutionPosition = z.infer<
  typeof WalletExecutionPositionSchema
>;

export const WalletExecutionMarketPositionSourceSchema = z.enum([
  "ledger",
  "trader_current_positions",
]);
export const WalletExecutionMarketPositionSideSchema = z.enum([
  "our_wallet",
  "copy_target",
]);

/**
 * Per-condition lifecycle for a single token leg. `unknown` is the v0 default
 * until `poly_market_outcomes` is populated; once that backfill lands, joined
 * outcome rows promote `unknown` to `winner`/`loser`/`resolved`. `inactive`
 * means the leg dropped out of the latest complete position fetch but is
 * retained for historical context.
 */
export const WalletExecutionMarketLegLifecycleSchema = z.enum([
  "active",
  "inactive",
  "resolved",
  "winner",
  "loser",
  "unknown",
]);
export type WalletExecutionMarketLegLifecycle = z.infer<
  typeof WalletExecutionMarketLegLifecycleSchema
>;

/**
 * One token leg of a participant's exposure to a single condition. A
 * participant has up to two legs per condition (primary + optional hedge).
 */
export const WalletExecutionMarketLegSchema = z.object({
  tokenId: z.string(),
  outcome: z.string(),
  shares: z.number().nonnegative(),
  currentValueUsdc: z.number().nonnegative(),
  costBasisUsdc: z.number().nonnegative(),
  vwap: z.number().min(0).nullable(),
  pnlUsdc: z.number(),
  lifecycle: WalletExecutionMarketLegLifecycleSchema,
});
export type WalletExecutionMarketLeg = z.infer<
  typeof WalletExecutionMarketLegSchema
>;

/**
 * One row per (wallet, conditionId): the participant's primary leg + optional
 * hedge leg pivoted onto a single shape so the dashboard can render value,
 * VWAP, and P/L for both legs side-by-side and a `net` summary across them.
 * Hedge classification is current-state only (smaller cost-basis leg of a
 * two-leg condition). Server-side pivot per
 * docs/spec/poly-copy-trade-execution.md.
 */
export const WalletExecutionMarketParticipantRowSchema = z.object({
  side: WalletExecutionMarketPositionSideSchema,
  source: WalletExecutionMarketPositionSourceSchema,
  label: z.string(),
  walletAddress: PolyAddressSchema,
  conditionId: z.string(),
  primary: WalletExecutionMarketLegSchema.nullable(),
  hedge: WalletExecutionMarketLegSchema.nullable(),
  net: z.object({
    currentValueUsdc: z.number().nonnegative(),
    costBasisUsdc: z.number().nonnegative(),
    pnlUsdc: z.number(),
  }),
  lastObservedAt: z.string().nullable(),
});
export type WalletExecutionMarketParticipantRow = z.infer<
  typeof WalletExecutionMarketParticipantRowSchema
>;

/**
 * Whether the row represents a market we still hold (`live`) or have already
 * closed/redeemed (`closed`). Drives the dashboard status filter.
 */
export const WalletExecutionMarketLineStatusSchema = z.enum(["live", "closed"]);
export type WalletExecutionMarketLineStatus = z.infer<
  typeof WalletExecutionMarketLineStatusSchema
>;

export const WalletExecutionMarketLineSchema = z.object({
  conditionId: z.string(),
  marketTitle: z.string(),
  marketSlug: z.string().nullable(),
  resolvesAt: z.string().nullable(),
  status: WalletExecutionMarketLineStatusSchema,
  ourValueUsdc: z.number().nonnegative(),
  targetValueUsdc: z.number().nonnegative(),
  /**
   * Σ snapshot.cost_basis_usdc on currently held shares — Polymarket
   * vendor-FIFO cost of the position as it exists right now. Used as the
   * P/L denominator (returns, Δ). Post-merge / post-partial-close aware:
   * shares disposed via SELL, negRisk merge, or redemption have already
   * been deducted from this number by Polymarket's accounting. After full
   * exit collapses to 0; for closed-line display reach for
   * `ourGrossBuyNotionalUsdc` to show lifetime entry instead.
   */
  ourEntryValueUsdc: z.number().nonnegative(),
  /** Same as `ourEntryValueUsdc` — Σ snapshot.cost_basis_usdc — but for
   * the target side. P/L denominator for target return %. */
  targetEntryValueUsdc: z.number().nonnegative(),
  /**
   * Σ poly_trader_fills BUY size_usdc for our wallet × condition.
   * "Lifetime BUY activity" — every dollar that left our wallet to buy
   * shares on this market, ever, including shares since disposed
   * (sold / merged / redeemed). Distinct from `ourEntryValueUsdc` for
   * partial-close traders and market-maker targets: for a target who
   * BOUGHT $36k and merged most of it back, gross = $36k while cost
   * basis on held shares ≈ $3k. NEVER use this as a P/L denominator;
   * surface in a separate, labeled column for activity awareness.
   */
  ourGrossBuyNotionalUsdc: z.number().nonnegative(),
  /** Same as `ourGrossBuyNotionalUsdc` — lifetime BUY activity — but
   * Σ'd across all target wallets on this condition. */
  targetGrossBuyNotionalUsdc: z.number().nonnegative(),
  ourVwap: z.number().min(0).nullable(),
  targetVwap: z.number().min(0).nullable(),
  hedgeCount: z.number().int().nonnegative(),
  /**
   * `edgeGapPct × ourTotalBuyNotional`. Bounded to OUR book scale; never
   * the legacy divide-by-near-zero artifact. Null when either return is
   * undefined (no copy-target legs with positive buy notional, or our
   * wallet has no observed buys yet).
   */
  edgeGapUsdc: z.number().nullable(),
  /**
   * `targetReturnPct − ourReturnPct` (Modified-Dietz, fractional). Positive
   * = targets are ahead = alpha leaking from us. Null when either side's
   * return cannot be computed.
   */
  edgeGapPct: z.number().nullable(),
  participants: z.array(WalletExecutionMarketParticipantRowSchema),
});
export type WalletExecutionMarketLine = z.infer<
  typeof WalletExecutionMarketLineSchema
>;

export const WalletExecutionMarketGroupSchema = z.object({
  groupKey: z.string(),
  eventTitle: z.string().nullable(),
  eventSlug: z.string().nullable(),
  marketCount: z.number().int().nonnegative(),
  /** `live` if any line in the group is still held, else `closed`. */
  status: WalletExecutionMarketLineStatusSchema,
  ourValueUsdc: z.number().nonnegative(),
  targetValueUsdc: z.number().nonnegative(),
  /** Group-level Σ of per-line `ourEntryValueUsdc`. */
  ourEntryValueUsdc: z.number().nonnegative(),
  /** Group-level Σ of per-line `targetEntryValueUsdc`. */
  targetEntryValueUsdc: z.number().nonnegative(),
  /** Group-level Σ of per-line `ourGrossBuyNotionalUsdc`. */
  ourGrossBuyNotionalUsdc: z.number().nonnegative(),
  /** Group-level Σ of per-line `targetGrossBuyNotionalUsdc`. */
  targetGrossBuyNotionalUsdc: z.number().nonnegative(),
  pnlUsd: z.number(),
  /**
   * Group-level `edgeGapPct × groupOurTotalBuyNotional`, where the
   * percentages are cost-basis-weighted blends across the group's lines.
   * Bounded to our book scale. Null when either blended return is
   * undefined.
   */
  edgeGapUsdc: z.number().nullable(),
  /**
   * Cost-basis-weighted blend of per-line `targetReturnPct − ourReturnPct`
   * across the group. Positive = targets ahead = alpha leaking. Null when
   * either side's blend is undefined.
   */
  edgeGapPct: z.number().nullable(),
  hedgeCount: z.number().int().nonnegative(),
  lines: z.array(WalletExecutionMarketLineSchema),
});
export type WalletExecutionMarketGroup = z.infer<
  typeof WalletExecutionMarketGroupSchema
>;

export const WalletExecutionWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type WalletExecutionWarning = z.infer<
  typeof WalletExecutionWarningSchema
>;

export const WalletExecutionDailyCountSchema = z.object({
  day: z.string(),
  n: z.number().int().nonnegative(),
});
export type WalletExecutionDailyCount = z.infer<
  typeof WalletExecutionDailyCountSchema
>;

export const PolyWalletExecutionOutputSchema = z.object({
  address: PolyAddressSchema,
  freshness: PolyWalletDataFreshnessSchema,
  capturedAt: z.string(),
  dailyTradeCounts: z.array(WalletExecutionDailyCountSchema),
  /** Currently held positions (status open or redeemable). Powers the Open tab. */
  live_positions: z.array(WalletExecutionPositionSchema),
  /** Event/market grouped exposure for comparing our positions with active copy targets. */
  market_groups: z.array(WalletExecutionMarketGroupSchema),
  /** Trade-derived closed position history. Powers the Position History tab. */
  closed_positions: z.array(WalletExecutionPositionSchema),
  warnings: z.array(WalletExecutionWarningSchema),
});
export type PolyWalletExecutionOutput = z.infer<
  typeof PolyWalletExecutionOutputSchema
>;

export const polyWalletExecutionOperation = {
  id: "poly.wallet.execution.v1",
  summary:
    "Trading-wallet execution positions and trades-per-day with traceable price timelines",
  description:
    "Returns the signed-in user's DB-backed daily trade counts, open positions (live_positions), and closed position history (closed_positions) for the trading-wallet dashboard.",
  input: z.object({
    freshness: PolyWalletDataFreshnessSchema.optional().default("read_model"),
  }),
  output: PolyWalletExecutionOutputSchema,
} as const;
