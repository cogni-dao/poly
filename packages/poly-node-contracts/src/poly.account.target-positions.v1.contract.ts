// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/poly-node-contracts/poly.account.target-positions.v1.contract`
 * Purpose: Human/agent contract for the persisted target and Position-gap
 *   decision books of one account's active copy targets.
 * Scope: Pure schemas and one operation literal. No authorization, DB, or IO.
 * Invariants:
 *   - PERSISTED_FACTS_ONLY: rows come from persisted observation/runtime tables.
 *   - NO_FABRICATED_VALUES: missing marks, P/L, metadata, and observations stay null/tagged.
 *   - BOUNDED_CURSOR_PAGES: positions are keyset-paginated, never exhaustively hydrated.
 * @public
 */

import { z } from "zod";

import {
	PolyPositionGapDecisionReasonSchema,
	PolyPositionGapRuntimeSchema,
} from "./poly.account.copy-operations.v1.contract";

const IsoTimestampSchema = z.string().datetime({ offset: true });
const PolyAddressSchema = z
	.string()
	.regex(/^0x[a-fA-F0-9]{40}$/)
	.transform((value) => value.toLowerCase());

export const POLY_TARGET_POSITIONS_DEFAULT_LIMIT = 25;
export const POLY_TARGET_POSITIONS_MAX_LIMIT = 100;
export const POLY_TARGET_POSITIONS_MAX_TARGETS = 50;
export const POLY_TARGET_POSITION_MAX_AGE_SECONDS = 6 * 60 * 60;

export const PolyTargetPositionsSortSchema = z.enum([
	"portfolio_weight",
	"current_value",
	"pnl",
	"last_observed",
]);
export type PolyTargetPositionsSort = z.infer<
	typeof PolyTargetPositionsSortSchema
>;

export const PolyAccountTargetPositionsQuerySchema = z.object({
	billing_account_id: z.string().uuid(),
	target_wallet: PolyAddressSchema.optional(),
	sort: PolyTargetPositionsSortSchema.default("portfolio_weight"),
	cursor: z.string().min(1).max(2048).optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(POLY_TARGET_POSITIONS_MAX_LIMIT)
		.default(POLY_TARGET_POSITIONS_DEFAULT_LIMIT),
});
export type PolyAccountTargetPositionsQuery = z.infer<
	typeof PolyAccountTargetPositionsQuerySchema
>;

/** Owner-session alias: authorization resolves the account from the principal. */
export const PolyAccountTargetPositionsOwnerQuerySchema =
	PolyAccountTargetPositionsQuerySchema.omit({ billing_account_id: true });

export const PolyTargetPositionObservationSchema = z.object({
	cursor_status: z
		.enum(["pending", "ok", "partial", "stale", "error"])
		.nullable(),
	last_success_at: IsoTimestampSchema.nullable(),
	last_position_observed_at: IsoTimestampSchema.nullable(),
	staleness_seconds: z.number().nonnegative().nullable(),
	freshness: z.enum(["fresh", "stale", "never_observed"]),
	completeness: z.enum(["complete", "partial", "unavailable"]),
	reason: z.enum([
		"complete_saved_snapshot",
		"saved_snapshot_stale",
		"wallet_not_observed",
		"positions_never_observed",
		"positions_cursor_not_ok",
	]),
});

export const PolyTargetPositionTargetSchema = z.object({
	target_id: z.string().uuid(),
	target_wallet: PolyAddressSchema,
	label: z.string().nullable(),
	live_position_count: z.number().int().nonnegative(),
	live_portfolio_value_usdc: z.number().nonnegative(),
	observation: PolyTargetPositionObservationSchema,
	position_gap_runtime: PolyPositionGapRuntimeSchema,
});

export const PolyTargetPositionRuntimeRowSchema = z.object({
	decision_reasons: z.array(PolyPositionGapDecisionReasonSchema).min(1),
	target_weight: z.number().min(0).max(1),
	desired_shares: z.number().nonnegative(),
	held_shares: z.number().nonnegative(),
	open_shares: z.number().nonnegative(),
	gap_shares: z.number().nonnegative(),
	locked_overweight_shares: z.number().nonnegative(),
	price_cap: z.number().positive().lt(1).nullable(),
	market_floor_usdc: z.number().nonnegative().nullable(),
	minimum_sleeve_usdc: z.number().nonnegative().nullable(),
	cohort_count: z.number().int().positive(),
});

export const PolyTargetPositionRowSchema = z.object({
	target_id: z.string().uuid(),
	target_wallet: PolyAddressSchema,
	target_label: z.string().nullable(),
	condition_id: z.string().min(1),
	token_id: z.string().min(1),
	market_title: z.string().nullable(),
	event_title: z.string().nullable(),
	outcome: z.string().nullable(),
	market_slug: z.string().nullable(),
	event_slug: z.string().nullable(),
	market_url: z.string().url().nullable(),
	row_source: z.enum(["saved_only", "saved_and_runtime", "runtime_only"]),
	shares: z.number().nonnegative().nullable(),
	cost_basis_usdc: z.number().nonnegative().nullable(),
	current_value_usdc: z.number().nonnegative().nullable(),
	portfolio_weight: z.number().min(0).max(1),
	entry_price: z.number().nonnegative().nullable(),
	current_price: z.number().nonnegative().nullable(),
	cash_pnl_usdc: z.number().nullable(),
	last_observed_at: IsoTimestampSchema,
	runtime: PolyTargetPositionRuntimeRowSchema.nullable(),
});
export type PolyTargetPositionRow = z.infer<typeof PolyTargetPositionRowSchema>;

export const PolyAccountTargetPositionsResponseSchema = z.object({
	billing_account_id: z.string().uuid(),
	captured_at: IsoTimestampSchema,
	target_wallet: PolyAddressSchema.nullable(),
	sort: PolyTargetPositionsSortSchema,
	limit: z.number().int().positive(),
	targets: z
		.array(PolyTargetPositionTargetSchema)
		.max(POLY_TARGET_POSITIONS_MAX_TARGETS),
	positions: z.array(PolyTargetPositionRowSchema),
	next_cursor: z.string().nullable(),
	truncated: z.boolean(),
	live_position_rule: z.object({
		active: z.literal(true),
		shares_greater_than: z.literal(0),
		max_age_seconds: z.literal(POLY_TARGET_POSITION_MAX_AGE_SECONDS),
	}),
	freshness: z.object({
		oldest_target_success_at: IsoTimestampSchema.nullable(),
		newest_position_observed_at: IsoTimestampSchema.nullable(),
	}),
	completeness: z.object({
		complete: z.boolean(),
		active_target_count: z.number().int().nonnegative(),
		targets_returned: z.number().int().nonnegative(),
		targets_truncated: z.boolean(),
		complete_targets: z.number().int().nonnegative(),
		partial_targets: z.number().int().nonnegative(),
		unavailable_targets: z.number().int().nonnegative(),
	}),
	sources: z.object({
		targets: z.literal("poly_copy_trade_targets"),
		positions: z.literal("poly_trader_current_positions"),
		metadata: z.literal("poly_market_metadata"),
		observation: z.literal("poly_trader_ingestion_cursors"),
		runtime: z.literal("poly_position_gap_runs.plan.diagnostics"),
	}),
});
export type PolyAccountTargetPositionsResponse = z.infer<
	typeof PolyAccountTargetPositionsResponseSchema
>;

export const polyAccountTargetPositionsOperation = {
	id: "poly.account.target-positions.v1",
	summary:
		"Persisted target portfolios and current Position-gap decision books for this account",
	input: PolyAccountTargetPositionsQuerySchema,
	output: PolyAccountTargetPositionsResponseSchema,
} as const;
