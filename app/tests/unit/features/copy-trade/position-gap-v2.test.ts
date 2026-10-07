// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import { buildMirrorTargetConfig } from "@/bootstrap/jobs/copy-trade-mirror.job";
import {
	applyPositionGapSizing,
	planMirrorFromFill,
	positionGapDesiredShares,
	targetVwapForToken,
} from "@/features/copy-trade/plan-mirror";
import type {
	MirrorTargetConfig,
	PositionGapSizingPolicy,
	RuntimeState,
} from "@/features/copy-trade/types";

const policy: PositionGapSizingPolicy = {
	kind: "position_gap",
};

const fill: Fill = {
	target_wallet: "0x2005d16a00000000000000000000000000000000",
	fill_id: "chain:position-gap-v2",
	source: "chain",
	market_id: "prediction-market:polymarket:condition",
	outcome: "YES",
	side: "BUY",
	price: 0.5,
	size_usdc: 50_000,
	observed_at: "2026-10-07T00:00:00.000Z",
	attributes: { asset: "token-1" },
};

function state(overrides: Partial<RuntimeState> = {}): RuntimeState {
	return {
		already_placed_ids: [],
		placed_fill_ids: [],
		target_position: {
			condition_id: "condition",
			tokens: [
				{
					token_id: "token-1",
					size_shares: 50_000,
					cost_usdc: 25_000,
					current_value_usdc: 25_000,
				},
			],
		},
		target_portfolio_current_value_usdc: 500_000,
		mirror_portfolio_current_value_usdc: 20,
		...overrides,
	};
}

describe("position_gap v2 portfolio weighting", () => {
	it("maps a target portfolio weight onto mirror NAV", () => {
		const result = applyPositionGapSizing(policy, fill, state(), 1, 1);
		// Target weight = $25k / $500k = 5%; local desired = 5% × $20 = $1.
		expect(result).toEqual({ ok: true, size_usdc: 1 });
	});

	it("does not saturate at the legacy $5 per-condition maximum", () => {
		const result = applyPositionGapSizing(
			policy,
			fill,
			state({
				target_position: {
					condition_id: "condition",
					tokens: [
						{
							token_id: "token-1",
							size_shares: 500_000,
							cost_usdc: 250_000,
							current_value_usdc: 250_000,
						},
					],
				},
			}),
			5,
			1,
		);
		// 50% of a $20 mirror is $10; no per-condition maximum participates.
		expect(result).toEqual({ ok: true, size_usdc: 10 });
	});

	it("places only the remaining share gap", () => {
		const result = applyPositionGapSizing(
			policy,
			fill,
			state({
				target_position: {
					condition_id: "condition",
					tokens: [
						{
							token_id: "token-1",
							size_shares: 100_000,
							cost_usdc: 50_000,
							current_value_usdc: 50_000,
						},
					],
				},
				mirror_token_qty_shares: 1,
			}),
			1,
			0.1,
		);
		// Desired is four shares ($2); one share is already held, so BUY $1.50.
		expect(result).toEqual({ ok: true, size_usdc: 1.5 });
	});

	it("fails closed when either portfolio denominator is unavailable", () => {
		const result = applyPositionGapSizing(
			policy,
			fill,
			state({ target_portfolio_current_value_usdc: undefined }),
			5,
			1,
		);
		expect(result).toEqual({
			ok: false,
			reason: "target_position_below_threshold",
		});
	});

	it("returns zero desired shares after the target exits a token", () => {
		expect(
			positionGapDesiredShares(
				"token-1",
				state({
					target_position: { condition_id: "condition", tokens: [] },
					target_portfolio_current_value_usdc: 0,
				}),
			),
		).toBe(0);
	});
});

const clientOrderId =
	"0x1111111111111111111111111111111111111111111111111111111111111111" as const;

function positionGapConfig(
	overrides: Partial<MirrorTargetConfig> = {},
): MirrorTargetConfig {
	return {
		target_id: "11111111-1111-4111-8111-111111111111",
		target_wallet: "0x2005d16a00000000000000000000000000000000",
		billing_account_id: "billing-1",
		created_by_user_id: "user-1",
		sizing: policy,
		placement: { kind: "mirror_limit" },
		vwap_tolerance: 0.005,
		...overrides,
	};
}

function vwapPlan(price: number, stateOverride: Partial<RuntimeState> = {}) {
	return planMirrorFromFill({
		fill: { ...fill, price },
		config: positionGapConfig(),
		state: state({
			target_position: {
				condition_id: "condition",
				tokens: [
					{
						token_id: "token-1",
						size_shares: 100,
						cost_usdc: 50,
						current_value_usdc: 50,
					},
				],
			},
			target_portfolio_current_value_usdc: 100,
			mirror_portfolio_current_value_usdc: 100,
			...stateOverride,
		}),
		client_order_id: clientOrderId,
		min_shares: 1,
		min_usdc_notional: 1,
	});
}

describe("position_gap BUY VWAP protection", () => {
	it("threads the default VWAP tolerance without adding dominance filters", () => {
		const config = buildMirrorTargetConfig({
			targetWallet: "0x2005d16a00000000000000000000000000000000",
			billingAccountId: "billing-1",
			createdByUserId: "user-1",
			sizingPolicyKind: "position_gap",
		});

		expect(config.vwap_tolerance).toBe(0.005);
		expect(config.min_target_side_fraction).toBeUndefined();
		expect(config.position_followup).toBeUndefined();
	});

	it.each([
		["below", 0.504],
		["equal", 0.505],
	] as const)("places when the limit is %s target VWAP + tolerance", (_, price) => {
		expect(vwapPlan(price)).toMatchObject({ kind: "place" });
	});

	it("skips above target VWAP + tolerance", () => {
		expect(vwapPlan(0.506)).toEqual({
			kind: "skip",
			reason: "vwap_floor_breach",
			position_branch: "new_entry",
		});
	});

	it("fails closed when target VWAP is missing", () => {
		expect(
			vwapPlan(0.5, {
				target_position: { condition_id: "condition", tokens: [] },
			}),
		).toEqual({
			kind: "skip",
			reason: "vwap_floor_breach",
			position_branch: "new_entry",
		});
	});

	it("fails closed when target VWAP is invalid", () => {
		const invalidPosition: NonNullable<RuntimeState["target_position"]> = {
			condition_id: "condition",
			tokens: [
				{
					token_id: "token-1",
					size_shares: 100,
					cost_usdc: 200,
					current_value_usdc: 50,
				},
			],
		};
		expect(targetVwapForToken(invalidPosition, "token-1")).toBeUndefined();
		expect(vwapPlan(0.5, { target_position: invalidPosition })).toEqual({
			kind: "skip",
			reason: "vwap_floor_breach",
			position_branch: "new_entry",
		});
	});

	it("fails closed when position_gap is constructed without a tolerance", () => {
		const plan = planMirrorFromFill({
			fill,
			config: positionGapConfig({ vwap_tolerance: undefined }),
			state: state(),
			client_order_id: clientOrderId,
			min_shares: 1,
			min_usdc_notional: 1,
		});

		expect(plan).toEqual({
			kind: "skip",
			reason: "vwap_floor_breach",
			position_branch: "new_entry",
		});
	});

	it("keeps mirror_fill_exact free of VWAP filtering", () => {
		const config = buildMirrorTargetConfig({
			targetWallet: "0x2005d16a00000000000000000000000000000000",
			billingAccountId: "billing-1",
			createdByUserId: "user-1",
			sizingPolicyKind: "mirror_fill_exact",
		});

		expect(config.vwap_tolerance).toBeUndefined();
		expect(config.min_target_side_fraction).toBeUndefined();
		expect(config.position_followup).toBeUndefined();
	});
});
