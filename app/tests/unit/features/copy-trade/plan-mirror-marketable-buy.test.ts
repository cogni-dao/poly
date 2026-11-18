// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.5057 — BUY limits are marketable within a bounded slippage allowance.
 * The target just swept the ask at its fill price, so a bid AT that price rests
 * below the new best ask and the TTL sweep cancels it unfilled.
 */

import type { Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import { planMirrorFromFill } from "@/features/copy-trade/plan-mirror";
import type {
	MirrorTargetConfig,
	RuntimeState,
} from "@/features/copy-trade/types";

const TARGET = "0x2005d16a00000000000000000000000000000000";
const COID =
	"0x2222222222222222222222222222222222222222222222222222222222222222" as const;

const baseFill: Fill = {
	target_wallet: TARGET,
	fill_id: "chain:marketable-buy",
	source: "chain",
	market_id: "prediction-market:polymarket:condition",
	outcome: "YES",
	side: "BUY",
	price: 0.75,
	size_usdc: 50,
	observed_at: "2026-10-07T00:00:00.000Z",
	attributes: { asset: "token-1" },
};

function cfg(overrides: Partial<MirrorTargetConfig> = {}): MirrorTargetConfig {
	return {
		target_id: "11111111-1111-4111-8111-111111111111",
		target_wallet: TARGET,
		billing_account_id: "billing-1",
		created_by_user_id: "user-1",
		sizing: { kind: "min_bet", max_usdc_per_condition: 5 },
		placement: { kind: "mirror_limit" },
		vwap_tolerance: 0.005,
		buy_slippage_allowance: 0.02,
		...overrides,
	};
}

/** Target VWAP on token-1 = cost / shares. */
function targetPosition(
	vwap: number,
): NonNullable<RuntimeState["target_position"]> {
	return {
		condition_id: "condition",
		tokens: [
			{
				token_id: "token-1",
				size_shares: 100,
				cost_usdc: vwap * 100,
				current_value_usdc: vwap * 100,
			},
		],
	};
}

function plan(params: {
	price?: number;
	config?: MirrorTargetConfig;
	vwap?: number;
	tick_size?: number | null;
	cumulative?: number;
}) {
	const price = params.price ?? 0.75;
	const tick = params.tick_size === undefined ? 0.01 : params.tick_size;
	return planMirrorFromFill({
		fill: { ...baseFill, price },
		config: params.config ?? cfg(),
		state: {
			already_placed_ids: [],
			placed_fill_ids: [],
			target_position: targetPosition(params.vwap ?? price),
			...(params.cumulative !== undefined
				? { cumulative_intent_usdc_for_token: params.cumulative }
				: {}),
		},
		client_order_id: COID,
		min_shares: 5,
		min_usdc_notional: 1,
		...(tick !== null ? { tick_size: tick } : {}),
	});
}

function placed(result: ReturnType<typeof plan>) {
	if (result.kind !== "place") {
		throw new Error(`expected place, got skip:${result.reason}`);
	}
	return result.intent;
}

describe("marketable BUY limit (bug.5057)", () => {
	it("bids above the fill, within the allowance, so it crosses a higher ask", () => {
		// Target swept to 0.75; the book's new best ask is 0.77 (within 0.02).
		const intent = placed(plan({ price: 0.75, vwap: 0.8 }));
		expect(intent.limit_price).toBeCloseTo(0.77, 10);
		expect(intent.limit_price).toBeGreaterThanOrEqual(0.77 - 1e-9);
		expect(intent.limit_price).toBeLessThanOrEqual(0.75 + 0.02 + 1e-9);
	});

	it("rounds UP to the tick grid", () => {
		const intent = placed(
			plan({
				price: 0.784,
				vwap: 0.85,
				tick_size: 0.001,
				config: cfg({ buy_slippage_allowance: 0.0005 }),
			}),
		);
		// 0.784 + 0.0005 = 0.7845 -> ceil to 0.785 on a 0.001 grid.
		expect(intent.limit_price).toBeCloseTo(0.785, 10);
	});

	it("is capped by target VWAP + vwap_tolerance", () => {
		// VWAP 0.755 + 0.005 = 0.76 < 0.75 + 0.02.
		const intent = placed(plan({ price: 0.75, vwap: 0.755 }));
		expect(intent.limit_price).toBeCloseTo(0.76, 10);
	});

	it("with VWAP == fill and the default 0.005 tolerance, never exceeds fill + 0.005", () => {
		const intent = placed(plan({ price: 0.75, vwap: 0.75 }));
		expect(intent.limit_price).toBeLessThanOrEqual(0.755 + 1e-9);
		expect(intent.limit_price).toBeGreaterThanOrEqual(0.75 - 1e-9);
	});

	it("is capped at 0.99", () => {
		const intent = placed(
			plan({
				price: 0.98,
				vwap: 0.99,
				config: cfg({ vwap_tolerance: 0.1, buy_slippage_allowance: 0.05 }),
			}),
		);
		expect(intent.limit_price).toBeCloseTo(0.99, 10);
	});

	it("re-sizes shares at the higher price without exceeding max_usdc_per_condition", () => {
		const intent = placed(plan({ price: 0.75, vwap: 0.8 }));
		expect(intent.size_usdc).toBeLessThanOrEqual(5 + 1e-9);
		const shares = intent.size_usdc / intent.limit_price;
		// The 5-share market floor holds at the limit price, not the fill price.
		expect(shares).toBeGreaterThanOrEqual(5 - 1e-9);
		// Legacy: 5 x 0.75 = 3.75 USDC; now 5 x 0.77 = 3.85 USDC.
		expect(intent.size_usdc).toBeCloseTo(5 * 0.77, 6);
	});

	it("falls back to the target fill price when the cumulative cap blocks the repriced size", () => {
		// 1.2 + 3.75 (at 0.75) = 4.95 <= 5 places; 1.2 + 3.85 = 5.05 > 5 does not.
		const intent = placed(plan({ price: 0.75, vwap: 0.8, cumulative: 1.2 }));
		expect(intent.limit_price).toBeCloseTo(0.75, 10);
		expect(intent.size_usdc).toBeCloseTo(3.75, 6);
		expect(intent.size_usdc + 1.2).toBeLessThanOrEqual(5 + 1e-9);
	});

	it("keeps the legacy limit when no allowance is configured", () => {
		const intent = placed(
			plan({
				price: 0.75,
				vwap: 0.8,
				config: cfg({ buy_slippage_allowance: undefined }),
			}),
		);
		expect(intent.limit_price).toBeCloseTo(0.75, 10);
	});

	it("keeps the legacy limit when the tick size is unknown", () => {
		const intent = placed(plan({ price: 0.75, vwap: 0.8, tick_size: null }));
		expect(intent.limit_price).toBeCloseTo(0.75, 10);
	});

	it("never adds slippage to verbatim fill-exact mirrors", () => {
		const intent = placed(
			plan({
				price: 0.75,
				config: cfg({
					sizing: { kind: "mirror_fill_exact" },
					vwap_tolerance: undefined,
				}),
			}),
		);
		expect(intent.limit_price).toBeCloseTo(0.75, 10);
	});

	it("does not change the VWAP gate: a fill above VWAP + tolerance still skips", () => {
		expect(plan({ price: 0.75, vwap: 0.7 })).toMatchObject({
			kind: "skip",
			reason: "vwap_floor_breach",
		});
	});
});
