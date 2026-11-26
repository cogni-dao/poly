// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * story.5028 — opt-in entry-price floor on `target_percentile_scaled`.
 * `sizing.min_entry_price` undefined ⇒ off (legacy behavior, same config_hash);
 * set ⇒ a BUY whose target fill price is below it skips `below_entry_price_floor`.
 */

import type { Fill } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import {
	ALGORITHM_DEFINITIONS,
	fillAlgorithmConfig,
	hashCanonical,
} from "@/features/copy-trade/algorithm-registry";
import { planMirrorFromFill } from "@/features/copy-trade/plan-mirror";
import {
	MirrorReasonSchema,
	type MirrorTargetConfig,
	SizingPolicySchema,
} from "@/features/copy-trade/types";
import { buildMirrorTargetConfig } from "@/bootstrap/jobs/copy-trade-mirror.job";

const TARGET = "0x2005d16a00000000000000000000000000000000";
const RN1_WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;
const CLIENT_ORDER_ID =
	"0x1111111111111111111111111111111111111111111111111111111111111111" as const;

const statistic = {
	wallet: TARGET,
	label: "fixture",
	captured_at: "2026-10-07T00:00:00.000Z",
	sample_size: 10,
	min_target_usdc: 1,
	max_target_usdc: 100,
	percentile: 75,
};

function fillAt(price: number, side: "BUY" | "SELL" = "BUY"): Fill {
	return {
		target_wallet: TARGET,
		fill_id: `chain:entry-floor-${price}-${side}`,
		source: "chain",
		market_id: "prediction-market:polymarket:condition",
		outcome: "YES",
		side,
		price,
		size_usdc: 50,
		observed_at: "2026-10-07T00:00:00.000Z",
		attributes: { asset: "token-1" },
	};
}

function config(minEntryPrice?: number): MirrorTargetConfig {
	return {
		target_id: "11111111-1111-4111-8111-111111111111",
		target_wallet: TARGET,
		billing_account_id: "billing-1",
		created_by_user_id: "user-1",
		sizing: {
			kind: "target_percentile_scaled",
			max_usdc_per_condition: 10,
			statistic,
			...(minEntryPrice !== undefined ? { min_entry_price: minEntryPrice } : {}),
		},
		placement: { kind: "mirror_limit" },
	};
}

// Target holds 100 shares at cost 50 on token-1 (VWAP 0.50, single side).
const targetPosition = {
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

function plan(
	price: number,
	minEntryPrice?: number,
	opts: { side?: "BUY" | "SELL"; withTargetPosition?: boolean } = {},
) {
	const withTargetPosition = opts.withTargetPosition ?? true;
	return planMirrorFromFill({
		fill: fillAt(price, opts.side),
		config: config(minEntryPrice),
		state: {
			already_placed_ids: [],
			placed_fill_ids: [],
			...(withTargetPosition ? { target_position: targetPosition } : {}),
		},
		client_order_id: CLIENT_ORDER_ID,
		min_shares: 1,
		min_usdc_notional: 1,
	});
}

describe("entry-price floor (story.5028)", () => {
	it("is registered as a bounded skip reason", () => {
		expect(MirrorReasonSchema.options).toContain("below_entry_price_floor");
	});

	it("is OFF by default: a sub-0.50 BUY places exactly as before", () => {
		expect(plan(0.4)).toMatchObject({ kind: "place" });
		expect(plan(0.4, undefined)).toEqual(plan(0.4));
	});

	it("skips a BUY below the floor", () => {
		expect(plan(0.49, 0.5)).toEqual({
			kind: "skip",
			reason: "below_entry_price_floor",
			position_branch: "new_entry",
		});
		expect(plan(0.1, 0.5)).toMatchObject({
			reason: "below_entry_price_floor",
		});
	});

	it("places a BUY exactly at the floor and above it", () => {
		expect(plan(0.5, 0.5)).toMatchObject({ kind: "place" });
	});

	it("fires before the target-position fail-closed gate", () => {
		expect(plan(0.4, 0.5, { withTargetPosition: false })).toMatchObject({
			kind: "skip",
			reason: "below_entry_price_floor",
		});
	});

	it("never gates SELLs", () => {
		expect(plan(0.3, 0.5, { side: "SELL" })).not.toMatchObject({
			reason: "below_entry_price_floor",
		});
	});

	it("rejects a floor outside 0..1", () => {
		const parse = (min_entry_price: number) =>
			SizingPolicySchema.safeParse({
				kind: "target_percentile_scaled",
				max_usdc_per_condition: 10,
				statistic,
				min_entry_price,
			}).success;
		expect(parse(0)).toBe(true);
		expect(parse(1)).toBe(true);
		expect(parse(-0.01)).toBe(false);
		expect(parse(1.01)).toBe(false);
	});
});

describe("entry-price floor — algorithm identity (poly-algorithm-contract)", () => {
	const def = ALGORITHM_DEFINITIONS["poly.copy-mirror.target-percentile-scaled"];

	it("bumps the scaled algorithm codeVersion", () => {
		expect(def.codeVersion).toBe("target-percentile-scaled-v3");
	});

	it("leaves config_hash unchanged when the floor is unset", () => {
		const withoutKey = fillAlgorithmConfig(config());
		const explicitUndefined = fillAlgorithmConfig({
			...config(),
			sizing: { ...config().sizing, min_entry_price: undefined } as never,
		});
		expect(hashCanonical(withoutKey)).toBe(hashCanonical(explicitUndefined));
		expect(JSON.stringify(withoutKey)).not.toContain("min_entry_price");
	});

	it("binds the floor into config_hash when set", () => {
		expect(hashCanonical(fillAlgorithmConfig(config(0.5)))).not.toBe(
			hashCanonical(fillAlgorithmConfig(config())),
		);
		expect(def.parseConfig(fillAlgorithmConfig(config(0.5))).success).toBe(
			true,
		);
	});

	it("decides below_entry_price_floor through the registry", () => {
		const input = {
			fill: fillAt(0.4),
			state: { already_placed_ids: [], placed_fill_ids: [] },
			min_shares: 1,
			min_usdc_notional: 1,
			tick_size: 0.01,
		};
		const parsedInput = def.parseInput(input);
		const parsedConfig = def.parseConfig(fillAlgorithmConfig(config(0.5)));
		expect(parsedInput.success && parsedConfig.success).toBe(true);
		if (!parsedInput.success || !parsedConfig.success) return;
		expect(def.decide(parsedInput.data, parsedConfig.data)).toMatchObject({
			status: "skipped",
			reason: "below_entry_price_floor",
			orders: [],
		});
	});
});

describe("buildMirrorTargetConfig threads minEntryPrice (default off)", () => {
	const base = {
		targetWallet: RN1_WALLET,
		billingAccountId: "billing-1",
		createdByUserId: "user-1",
		sizingPolicyKind: "target_percentile_scaled" as const,
	};

	it("omits the key unless a floor is passed", () => {
		const off = buildMirrorTargetConfig(base);
		expect(off.sizing).toMatchObject({ kind: "target_percentile_scaled" });
		expect("min_entry_price" in off.sizing).toBe(false);
	});

	it("carries the floor onto the scaled sizing policy", () => {
		const on = buildMirrorTargetConfig({ ...base, minEntryPrice: 0.5 });
		expect(on.sizing).toMatchObject({
			kind: "target_percentile_scaled",
			min_entry_price: 0.5,
		});
	});
});
