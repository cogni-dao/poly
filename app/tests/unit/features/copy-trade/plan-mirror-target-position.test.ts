// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.5053 — BUY gates fail closed when the target position is unavailable.
 * Previously a missing target_position silently disabled the dominance and
 * VWAP gates for non-position_gap policies.
 */

import type { Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import {
	planMirrorFromFill,
	planRequiresTargetPosition,
} from "@/features/copy-trade/plan-mirror";
import type {
	MirrorTargetConfig,
	RuntimeState,
} from "@/features/copy-trade/types";

const TARGET = "0x2005d16a00000000000000000000000000000000";
const CLIENT_ORDER_ID =
	"0x1111111111111111111111111111111111111111111111111111111111111111" as const;

const fill: Fill = {
	target_wallet: TARGET,
	fill_id: "chain:target-position-unavailable",
	source: "chain",
	market_id: "prediction-market:polymarket:condition",
	outcome: "YES",
	side: "BUY",
	price: 0.5,
	size_usdc: 50,
	observed_at: "2026-10-07T00:00:00.000Z",
	attributes: { asset: "token-1" },
};

function tpsConfig(
	overrides: Partial<MirrorTargetConfig> = {},
): MirrorTargetConfig {
	return {
		target_id: "11111111-1111-4111-8111-111111111111",
		target_wallet: TARGET,
		billing_account_id: "billing-1",
		created_by_user_id: "user-1",
		sizing: {
			kind: "target_percentile_scaled",
			max_usdc_per_condition: 10,
			statistic: {
				wallet: TARGET,
				label: "fixture",
				captured_at: "2026-10-07T00:00:00.000Z",
				sample_size: 10,
				min_target_usdc: 1,
				max_target_usdc: 100,
				percentile: 75,
			},
		},
		placement: { kind: "mirror_limit" },
		min_target_side_fraction: 0.2,
		vwap_tolerance: 0.005,
		...overrides,
	};
}

const targetPosition: NonNullable<RuntimeState["target_position"]> = {
	condition_id: "condition",
	tokens: [
		{
			token_id: "token-1",
			size_shares: 100,
			cost_usdc: 50,
			current_value_usdc: 50,
		},
	],
};

function plan(params: {
	side?: "BUY" | "SELL";
	price?: number;
	config?: MirrorTargetConfig;
	target_position?: RuntimeState["target_position"];
}) {
	return planMirrorFromFill({
		fill: { ...fill, side: params.side ?? "BUY", price: params.price ?? 0.5 },
		config: params.config ?? tpsConfig(),
		state: {
			already_placed_ids: [],
			placed_fill_ids: [],
			...(params.target_position
				? { target_position: params.target_position }
				: {}),
		},
		client_order_id: CLIENT_ORDER_ID,
		min_shares: 1,
		min_usdc_notional: 1,
	});
}

describe("BUY gates fail closed without a target position (bug.5053)", () => {
	it("skips a target_percentile_scaled BUY with target_position_unavailable", () => {
		expect(plan({})).toEqual({
			kind: "skip",
			reason: "target_position_unavailable",
			position_branch: "new_entry",
		});
	});

	it("skips when only the VWAP tolerance relies on the target position", () => {
		const config = tpsConfig({ min_target_side_fraction: undefined });
		expect(plan({ config })).toMatchObject({
			kind: "skip",
			reason: "target_position_unavailable",
		});
	});

	it("skips when only the dominance threshold relies on the target position", () => {
		const config = tpsConfig({ vwap_tolerance: undefined });
		expect(plan({ config })).toMatchObject({
			kind: "skip",
			reason: "target_position_unavailable",
		});
	});

	it("still evaluates the gates when the target position is present", () => {
		expect(plan({ target_position: targetPosition })).toMatchObject({
			kind: "place",
		});
		// target VWAP is 0.50; 0.51 is above VWAP + 0.005 tolerance.
		expect(plan({ price: 0.51, target_position: targetPosition })).toEqual({
			kind: "skip",
			reason: "vwap_floor_breach",
			position_branch: "new_entry",
		});
	});

	it("still applies the dominance gate when the target position is present", () => {
		const minority: NonNullable<RuntimeState["target_position"]> = {
			condition_id: "condition",
			tokens: [
				{
					token_id: "token-1",
					size_shares: 10,
					cost_usdc: 5,
					current_value_usdc: 5,
				},
				{
					token_id: "token-2",
					size_shares: 90,
					cost_usdc: 45,
					current_value_usdc: 45,
				},
			],
		};
		expect(plan({ target_position: minority })).toEqual({
			kind: "skip",
			reason: "target_dominant_other_side",
			position_branch: "new_entry",
		});
	});

	it("fails closed when a configured tolerance has no VWAP for the fill token", () => {
		expect(
			plan({
				target_position: { condition_id: "condition", tokens: [] },
				config: tpsConfig({ min_target_side_fraction: undefined }),
			}),
		).toEqual({
			kind: "skip",
			reason: "vwap_floor_breach",
			position_branch: "new_entry",
		});
	});

	it("does not apply to SELL fills", () => {
		expect(plan({ side: "SELL" })).not.toMatchObject({
			reason: "target_position_unavailable",
		});
	});

	it("does not gate policies that rely on no target facts", () => {
		const verbatim = tpsConfig({
			sizing: { kind: "mirror_fill_exact" },
			min_target_side_fraction: undefined,
			vwap_tolerance: undefined,
		});
		expect(planRequiresTargetPosition(verbatim)).toBe(false);
		expect(plan({ config: verbatim })).toMatchObject({ kind: "place" });
	});
});
