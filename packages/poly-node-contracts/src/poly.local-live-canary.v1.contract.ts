// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@contracts/poly.local-live-canary.v1.contract`
 * Purpose: Local-development-only contract for proving one bounded live order
 *   through the production mirror planner, ledger, authorization, signer, and
 *   CLOB path.
 * Scope: Schema only. The route is session-authenticated and is unavailable
 *   outside a non-CI `NODE_ENV=development` process.
 * Invariants:
 *   - EXPLICIT_REAL_MONEY_CONFIRMATION — every call carries the exact consent
 *     phrase; there is no sticky enable switch.
 *   - SIZE_IS_CODE_OWNED — callers provide market facts, never order notional.
 *     The versioned algorithm owns sizing and the server hard-caps it at $2.
 *   - FIXED_INPUT_IS_REPLAYABLE — the same body produces the same
 *     `fixed_input_id`; algorithm version advances order identity separately.
 * Side-effects: none.
 * Links: work/items/task.1791070987, story.5018
 * @public
 */

import { z } from "zod";

export const POLY_LOCAL_LIVE_CONFIRMATION =
	"PLACE_REAL_ORDER_UP_TO_2_USDC" as const;

const orderStatusSchema = z.enum([
	"pending",
	"open",
	"filled",
	"partial",
	"canceled",
	"error",
]);

export const polyLocalLiveCanaryOperation = {
	id: "poly.local-live-canary.v1",
	summary:
		"Place and clean up one explicitly confirmed, locally initiated live algorithm canary",
	description:
		"Development-only and never available in CI or deployed builds. Uses a deterministic fixed market input while order size and algorithm version remain code-owned.",
	input: z
		.object({
			confirmation: z.literal(POLY_LOCAL_LIVE_CONFIRMATION),
			fixed_input: z
				.object({
					condition_id: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
					token_id: z.string().regex(/^\d{1,80}$/),
					outcome: z.string().trim().min(1).max(80),
					price: z.number().gt(0).lt(1),
				})
				.strict(),
		})
		.strict(),
	output: z.object({
		schema_version: z.literal("poly.local-live-canary.v1"),
		local_sha: z.string().min(7),
		fixed_input_id: z.string().regex(/^0x[a-f0-9]{64}$/),
		correlation_id: z.string().regex(/^local-canary-[a-f0-9]{32}$/),
		algorithm_version: z.string().min(1),
		algorithm_parameter: z.object({ order_usdc: z.number().gt(0).max(2) }),
		market_eligibility: z.object({
			eligible: z.boolean(),
			min_shares: z.number().nonnegative(),
			min_usdc_notional: z.number().nonnegative(),
			floor_usdc: z.number().nonnegative(),
			normalized_price: z.number().gt(0).lt(1),
			tick_size: z.number().gt(0).lt(1).nullable(),
		}),
		decision: z.object({
			outcome: z.enum(["placed", "skipped", "error"]),
			reason: z.string().nullable(),
			/** Persisted planned notional, read back from the decision intent. */
			size_usdc: z.number().gt(0).max(2),
			correlation_id: z.string().min(1),
			algorithm_version: z.string().min(1),
		}),
		ledger: z.object({
			fill_id: z.string().min(1),
			client_order_id: z.string().min(1).nullable(),
			order_id: z.string().min(1).nullable(),
			status: orderStatusSchema.nullable(),
			correlation_id: z.string().min(1),
			algorithm_version: z.string().min(1),
		}),
		clob: z.object({
			order_id: z.string().min(1).nullable(),
			status: orderStatusSchema.nullable(),
			status_source: z.enum(["get_order", "placement_receipt", "not_placed"]),
		}),
		cleanup: z.object({
			attempted: z.boolean(),
			status: z.enum(["not_needed", "canceled", "already_terminal", "failed"]),
			error: z.string().max(256).nullable(),
		}),
		api: z.object({
			request_id: z.string().min(1),
			route_id: z.literal("poly.dev.live_algorithm_canary"),
			correlation_id: z.string().min(1),
		}),
	}),
} as const;

export const polyLocalLiveCanaryErrorSchema = z.object({
	schema_version: z.literal("poly.local-live-canary.error.v1"),
	error: z.enum([
		"confirmation_required",
		"local_development_only",
		"ci_forbidden",
		"live_dispatch_required",
		"local_sha_unavailable",
		"egress_geoblocked",
		"egress_unproven",
		"wallet_executor_unconfigured",
		"market_ineligible",
		"canary_execution_failed",
	]),
	reason: z.string().min(1).max(512),
	egress: z
		.object({
			verdict: z.enum(["blocked", "permitted", "unreachable"]).nullable(),
			country: z.string().nullable(),
			region: z.string().nullable(),
		})
		.optional(),
	market_eligibility:
		polyLocalLiveCanaryOperation.output.shape.market_eligibility.optional(),
	correlation_id: z.string().optional(),
});

export type PolyLocalLiveCanaryInput = z.infer<
	typeof polyLocalLiveCanaryOperation.input
>;
export type PolyLocalLiveCanaryOutput = z.infer<
	typeof polyLocalLiveCanaryOperation.output
>;
export type PolyLocalLiveCanaryError = z.infer<
	typeof polyLocalLiveCanaryErrorSchema
>;
