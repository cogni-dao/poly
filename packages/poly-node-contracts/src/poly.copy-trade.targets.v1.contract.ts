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
const isoTimestampSchema = z.string().datetime({ offset: true });

const mirrorMaxUsdcPerTradeSchema = z
  .number()
  .positive()
  .finite()
  .max(MAX_MIRROR_USDC_PER_TRADE)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, {
    message: "Expected a value with at most 2 decimal places",
  });

/** Optional capital reservation for one position-gap target; null means auto. */
const mirrorCapitalBudgetUsdcSchema = mirrorMaxUsdcPerTradeSchema.nullable();

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
 * Legacy position_gap v1 range field. Retained on the wire so old rows and
 * clients round-trip, but position_gap v2 never reads it.
 */
const targetRangeMaxUsdcSchema = mirrorMaxUsdcPerTradeSchema;

/**
 * Legacy position_gap v1 per-condition allocation field. Retained for
 * backward-compatible reads only; v2 scales from live mirror NAV.
 */
const mirrorMaxAllocPerConditionUsdcSchema = mirrorMaxUsdcPerTradeSchema;

const targetPolicySchema = z.object({
  mirror_filter_percentile: z.number().int().min(50).max(99),
  mirror_max_usdc_per_trade: mirrorMaxUsdcPerTradeSchema,
  /** Optional override; omit (or `'auto'`) to keep legacy snapshot inference. */
  sizing_policy_kind: sizingPolicyKindSchema.optional(),
  /** Legacy position_gap v1 field; accepted only for wire compatibility. */
  target_range_max_usdc: targetRangeMaxUsdcSchema.optional(),
  /** Legacy position_gap v1 field; accepted only for wire compatibility. */
  mirror_max_alloc_per_condition_usdc:
    mirrorMaxAllocPerConditionUsdcSchema.optional(),
  /** Position-gap portfolio budget. Null/omitted shares available mirror NAV. */
  mirror_capital_budget_usdc: mirrorCapitalBudgetUsdcSchema.optional(),
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
  /** Legacy display notional; ignored when sizing_policy_kind is position_gap. */
  mirror_usdc: z.number().positive(),
  /** Target fill percentile floor; fills below this target-wallet size percentile skip. */
  mirror_filter_percentile: targetPolicySchema.shape.mirror_filter_percentile,
  /** Target-specific max mirror notional; p100 target fills map to this value. */
  mirror_max_usdc_per_trade: targetPolicySchema.shape.mirror_max_usdc_per_trade,
  /**
   * Actual planner sizing policy for this wallet. `'auto'` means inherit
   * from snapshot (uncurated wallets resolve to `min_bet`, curated to
   * `target_percentile_scaled`). Explicit values pin the planner regardless
   * of snapshot availability.
   */
  sizing_policy_kind: sizingPolicyKindSchema,
  /** Legacy position_gap v1 field; compatibility-only in v2. */
  target_range_max_usdc: targetRangeMaxUsdcSchema.nullable(),
  /** Legacy position_gap v1 field; compatibility-only in v2. */
  mirror_max_alloc_per_condition_usdc:
    mirrorMaxAllocPerConditionUsdcSchema.nullable(),
  /** Position-gap portfolio budget. Null means automatic/full available NAV. */
  mirror_capital_budget_usdc: mirrorCapitalBudgetUsdcSchema,
  /** Optimistic-concurrency token and cold-start fence for this configuration. */
  mirror_activated_at: isoTimestampSchema,
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
   * Legacy position_gap v1 field accepted for backward compatibility.
   */
  target_range_max_usdc: targetRangeMaxUsdcSchema.optional(),
  /**
   * Legacy position_gap v1 field accepted for backward compatibility.
   */
  mirror_max_alloc_per_condition_usdc:
    mirrorMaxAllocPerConditionUsdcSchema.optional(),
  /** Position-gap portfolio budget. Null/omitted uses automatic allocation. */
  mirror_capital_budget_usdc: mirrorCapitalBudgetUsdcSchema.optional(),
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
  input: z
    .object({
      id: z.string().uuid(),
      /** Required on PATCH so the API never overwrites a newer human save. */
      expected_mirror_activated_at: isoTimestampSchema,
      /** PATCH always names the complete next policy; no hidden inherited kind. */
      sizing_policy_kind: sizingPolicyKindSchema,
    })
    .merge(targetPolicySchema.omit({ sizing_policy_kind: true })),
  output: z.object({
    target: targetSchema,
  }),
} as const;

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
