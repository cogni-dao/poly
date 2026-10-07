// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import {
	applyPositionGapSizing,
	positionGapDesiredShares,
} from "@/features/copy-trade/plan-mirror";
import type {
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
