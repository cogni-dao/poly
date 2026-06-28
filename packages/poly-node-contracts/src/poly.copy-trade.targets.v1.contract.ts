// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/poly.copy-trade.targets.v1.contract`
 * Purpose: Contracts for managing the calling user's Polymarket copy-trade tracked wallets.
 *          List (GET), create (POST), delete (DELETE) — all RLS-scoped to the session user.
 * Scope: Schema-only. Does not execute trades, does not modify on-chain state, does not own
 *        target-resolution logic (lives in `CopyTradeTargetSource`).
 * Invariants:
 *   - TENANT_SCOPED: rows are RLS-clamped to `created_by_user_id = current_setting('app.current_user_id', true)`.
 *     Cross-tenant reads/writes blocked at the DB layer.
 *   - NO_KILL_SWITCH (bug.0438): there is no per-tenant kill-switch field on
 *     the wire. The act of POSTing a target IS the user's opt-in; DELETE of
 *     the target row is the only way to stop mirror placements.
 *   - SOURCE_REFLECTS_PORT: the `source` field reflects which `CopyTradeTargetSource` impl
 *     produced the row (`"env"` for the local-dev fallback, `"db"` for production).
 * Side-effects: none
 * Notes: Target rows own the copy filter percentile and per-target max bet. Wallet grants
 *        remain the downstream authorization/cap layer before placement.
 * Links: docs/spec/poly-tenant-and-collateral.md, work/items/task.0318
 * @public
 */

import { z } from "zod";

const MAX_MIRROR_USDC_PER_TRADE = 99_999_999.99;

const mirrorMaxUsdcPerTradeSchema = z
  .number()
  .positive()
  .finite()
  .max(MAX_MIRROR_USDC_PER_TRADE)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, {
    message: "Expected a value with at most 2 decimal places",
  });

/**
 * Per-target sizing-policy kind. `'auto'` (default) preserves legacy
 * snapshot-derived behavior — `buildSizingPolicy` infers
 * `target_percentile_scaled` when the wallet has a curated snapshot, else
 * `min_bet`. Explicit kinds let users / AI pin a target to a specific
 * planner policy. Adding a new variant means updating the
 * `SizingPolicySchema` discriminated union in `features/copy-trade/types.ts`
 * AND the DB CHECK on `poly_copy_trade_targets.sizing_policy_kind` together.
 */
const sizingPolicyKindSchema = z.enum([
  "auto",
  "min_bet",
  "target_percentile_scaled",
  "position_gap",
  /**
   * Verbatim per-fill mirror — `size_usdc = fill.size_usdc`,
   * `limit_price = fill.price`, market-floor clamp only. No percentile,
   * scaling, cap, or follow-up branches. Polymarket's wire is
   * `(price, shares)`; setting USDC and price equal to the target's
   * reproduces target's exact wire order. Used for algorithm-validity
   * evaluation: strips conviction filters so any PnL gap vs target
   * localizes to execution quality.
   *
   * `mirror_filter_percentile` and `mirror_max_usdc_per_trade` remain
   * wire-required but are IGNORED when policy resolves to this kind.
   * `mirror_capital_alloc_usdc` is also ignored (this kind has no
   * book-scale parameter).
   */
  "mirror_fill_exact",
]);

/**
 * Per-target assumed per-condition position ceiling for `position_gap`. Drives
 * `relative = min(delta / target_range_max_usdc, 1.0)` in
 * `applyPositionGapSizing`. Parameterized to swisstony/RN1's p95 of
 * per-condition peak cost-basis (~$10k); operator PATCHes upward when
 * `poly.mirror.range_breach` alerts fire. NULLable on the row; required (DB
 * CHECK) when `sizing_policy_kind = 'position_gap'`. Same shape as
 * `mirror_max_usdc_per_trade` (positive USDC, ≤ 2 decimals).
 *
 * task.5014 — see docs/research/poly/range-relative-mirror-2026-05-26.md.
 */
const targetRangeMaxUsdcSchema = mirrorMaxUsdcPerTradeSchema;

/**
 * Per-condition USDC ceiling this mirror commits per condition under
 * `position_gap`. Drives `desired_usdc = mirror_max_alloc_per_condition_usdc ×
 * relative`. NULLable on the row; required (DB CHECK) when
 * `sizing_policy_kind = 'position_gap'`. Aggregate exposure scales as
 * `max_alloc × N_active_conditions`; wire-level safety lives in
 * `poly_wallet_grants` (`CAPS_LIVE_IN_GRANT`).
 *
 * task.5014 — see docs/research/poly/range-relative-mirror-2026-05-26.md.
 */
const mirrorMaxAllocPerConditionUsdcSchema = mirrorMaxUsdcPerTradeSchema;

const targetPolicySchema = z.object({
  mirror_filter_percentile: z.number().int().min(50).max(99),
  mirror_max_usdc_per_trade: mirrorMaxUsdcPerTradeSchema,
  /** Optional override; omit (or `'auto'`) to keep legacy snapshot inference. */
  sizing_policy_kind: sizingPolicyKindSchema.optional(),
  /** Per-target assumed per-condition position ceiling for `position_gap`. Required when policy resolves to `position_gap` (server-side CHECK). Omit to keep current value (PATCH) or leave NULL (POST for non-position_gap rows). */
  target_range_max_usdc: targetRangeMaxUsdcSchema.optional(),
  /** Per-condition USDC cap for `position_gap`. Required when policy resolves to `position_gap` (server-side CHECK). Omit to keep current value (PATCH) or leave NULL (POST for non-position_gap rows). */
  mirror_max_alloc_per_condition_usdc:
    mirrorMaxAllocPerConditionUsdcSchema.optional(),
});

const targetSchema = z.object({
  /**
   * `poly_copy_trade_targets.id` — DB row PK uuid. Pass this value to
   * `DELETE /api/v1/poly/copy-trade/targets/:id`. Distinct from the deterministic
   * UUIDv5 derived from `target_wallet` that lives in the fills ledger's
   * `target_id` column for `client_order_id` correlation; that value is internal.
   */
  target_id: z.string().uuid(),
  /** 0x-prefixed 40-hex — the wallet being watched / copied. */
  target_wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  /** Effective max mirror notional per fill (USDC) for this target. */
  mirror_usdc: z.number().positive(),
  /** Target fill percentile floor; fills below this target-wallet size percentile skip. */
  mirror_filter_percentile: targetPolicySchema.shape.mirror_filter_percentile,
  /** Target-specific max mirror notional; p100 target fills map to this value. */
  mirror_max_usdc_per_trade:
    targetPolicySchema.shape.mirror_max_usdc_per_trade,
  /**
   * Actual planner sizing policy for this wallet. `'auto'` means inherit
   * from snapshot (uncurated wallets resolve to `min_bet`, curated to
   * `target_percentile_scaled`). Explicit values pin the planner regardless
   * of snapshot availability.
   */
  sizing_policy_kind: sizingPolicyKindSchema,
  /** Per-target assumed per-condition position ceiling for `position_gap`. Null on rows where the policy isn't `position_gap`; required (DB CHECK) when it is. */
  target_range_max_usdc: targetRangeMaxUsdcSchema.nullable(),
  /** Per-condition USDC cap for `position_gap`. Null on rows where the policy isn't `position_gap`; required (DB CHECK) when it is. */
  mirror_max_alloc_per_condition_usdc:
    mirrorMaxAllocPerConditionUsdcSchema.nullable(),
  /** Provenance: `"env"` for the local-dev fallback; `"db"` once `dbTargetSource` is wired. */
  source: z.enum(["env", "db"]),
});

export const polyCopyTradeTargetsOperation = {
  id: "poly.copy-trade.targets.v1",
  summary: "List wallets the calling user is monitoring / copy-trading",
  description:
    "Returns the calling user's tracked wallets. RLS-scoped: a user sees only their own rows.",
  input: z.object({}),
  output: z.object({
    targets: z.array(targetSchema),
  }),
} as const;

const targetCreateInputSchema = z.object({
  target_wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  /**
   * Optional initial sizing-policy kind. Defaults to `'auto'` (server-side)
   * if omitted, matching the DB column default.
   */
  sizing_policy_kind: sizingPolicyKindSchema.optional(),
  /**
   * Initial assumed per-condition position ceiling for `position_gap`.
   * Required (server-side CHECK) when `sizing_policy_kind === 'position_gap'`;
   * NULLable for other kinds. task.5014.
   */
  target_range_max_usdc: targetRangeMaxUsdcSchema.optional(),
  /**
   * Initial per-condition USDC cap for `position_gap`. Required (server-side
   * CHECK) when `sizing_policy_kind === 'position_gap'`; NULLable for other
   * kinds. task.5014.
   */
  mirror_max_alloc_per_condition_usdc:
    mirrorMaxAllocPerConditionUsdcSchema.optional(),
});

export const polyCopyTradeTargetCreateOperation = {
  id: "poly.copy-trade.targets.create.v1",
  summary: "Add a wallet to the calling user's tracked list",
  description:
    "Creates a new `poly_copy_trade_targets` row owned by the session user. Tenant-scoped via RLS. Returns the created row in the same shape as GET.",
  input: targetCreateInputSchema,
  output: z.object({
    target: targetSchema,
  }),
} as const;

export const polyCopyTradeTargetDeleteOperation = {
  id: "poly.copy-trade.targets.delete.v1",
  summary: "Remove a wallet from the calling user's tracked list",
  description:
    "Soft-deletes a `poly_copy_trade_targets` row by setting `disabled_at`. Tenant-scoped via RLS — a user cannot delete another user's row (returns 404).",
  input: z.object({ id: z.string().uuid() }),
  output: z.object({
    deleted: z.boolean(),
  }),
} as const;

export const polyCopyTradeTargetUpdateOperation = {
  id: "poly.copy-trade.targets.update.v1",
  summary: "Update one tracked wallet's copy sizing policy",
  description:
    "Updates the caller-owned target row's percentile floor and max mirror notional. Tenant-scoped via RLS; path id selects the row.",
  input: z.object({ id: z.string().uuid() }).merge(targetPolicySchema),
  output: z.object({
    target: targetSchema,
  }),
} as const;

/**
 * Cross-field rule that the DB CHECK constraint enforces at write-time:
 * `position_gap` targets MUST carry BOTH an explicit `target_range_max_usdc`
 * AND an explicit `mirror_max_alloc_per_condition_usdc`. The route uses this
 * to return a 400 (instead of letting the DB 500 with a CHECK violation).
 * Tests pin the rule on inputs that look valid to the Zod schema but violate
 * the cross-field invariant.
 *
 * **bug.5026 ratio guard.** Beyond presence, the planner formula
 * `desired_usdc = mirror_max_alloc_per_condition_usdc × min(delta/target_range_max_usdc, 1)`
 * silently under-sizes when `mirror_max_alloc_per_condition_usdc` is far
 * smaller than `target_range_max_usdc`. At saturation (`delta ≥ range_max`)
 * desired peaks at `max_alloc` — so a $15/$500k row places at most $15 per
 * condition when the target has run $500k+ into one market. That isn't a
 * cap, it's a 0.003%-scale mirror that produces sub-floor sizing on every
 * fill (`below_market_min`) indistinguishable from "target hasn't moved."
 * Reject ratios below {@link MIN_ALLOC_TO_RANGE_RATIO} at the API so the
 * misconfig is loud at write-time instead of silent at runtime.
 *
 * Returns `null` when the input is valid, or a stable string code when not.
 * No throwing — the caller wraps the code into its preferred HTTP error shape.
 *
 * task.5014 — replaces the legacy `validatePositionGapCapitalAlloc` rule.
 *
 * @public
 */
export type RangeKnobsRuleViolation =
  | "position_gap_requires_target_range_max_usdc"
  | "position_gap_requires_mirror_max_alloc_per_condition_usdc"
  | "position_gap_alloc_range_ratio_too_small";

/**
 * Minimum `mirror_max_alloc_per_condition_usdc / target_range_max_usdc` ratio
 * accepted by {@link validatePositionGapRangeKnobs}. Anything below this is
 * almost certainly a misconfig (bug.5026): a 5%-of-target-range mirror still
 * places $250 on a $5k delta, well above the $5 CLOB floor. Operators who
 * genuinely want sub-5% fractional mirroring should propose a code-level
 * change rather than smuggle it through a knob the planner treats as a
 * cap. @public
 */
export const MIN_ALLOC_TO_RANGE_RATIO = 0.05;

export function validatePositionGapRangeKnobs(input: {
  sizing_policy_kind?: SizingPolicyKind | undefined;
  target_range_max_usdc?: number | undefined;
  mirror_max_alloc_per_condition_usdc?: number | undefined;
}): RangeKnobsRuleViolation | null {
  if (input.sizing_policy_kind !== "position_gap") {
    return null;
  }
  if (input.target_range_max_usdc === undefined) {
    return "position_gap_requires_target_range_max_usdc";
  }
  if (input.mirror_max_alloc_per_condition_usdc === undefined) {
    return "position_gap_requires_mirror_max_alloc_per_condition_usdc";
  }
  if (
    input.target_range_max_usdc > 0 &&
    input.mirror_max_alloc_per_condition_usdc /
      input.target_range_max_usdc <
      MIN_ALLOC_TO_RANGE_RATIO
  ) {
    return "position_gap_alloc_range_ratio_too_small";
  }
  return null;
}

export type SizingPolicyKind = z.infer<typeof sizingPolicyKindSchema>;
export type PolyCopyTradeTarget = z.infer<typeof targetSchema>;
export type PolyCopyTradeTargetsOutput = z.infer<
  typeof polyCopyTradeTargetsOperation.output
>;
export type PolyCopyTradeTargetCreateInput = z.infer<
  typeof polyCopyTradeTargetCreateOperation.input
>;
export type PolyCopyTradeTargetCreateOutput = z.infer<
  typeof polyCopyTradeTargetCreateOperation.output
>;
export type PolyCopyTradeTargetDeleteOutput = z.infer<
  typeof polyCopyTradeTargetDeleteOperation.output
>;
export type PolyCopyTradeTargetUpdateInput = z.infer<
  typeof polyCopyTradeTargetUpdateOperation.input
>;
export type PolyCopyTradeTargetUpdateOutput = z.infer<
  typeof polyCopyTradeTargetUpdateOperation.output
>;
