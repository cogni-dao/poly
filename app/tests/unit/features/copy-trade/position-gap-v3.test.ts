// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";

import { allocatePositionGapLots } from "@/features/copy-trade/position-gap-v3/allocator";
import { planPositionGapBook } from "@/features/copy-trade/position-gap-v3/batch-plan";
import type {
	PositionGapBookInputV1,
	PositionGapCandidateV1,
} from "@/features/copy-trade/position-gap-v3/model";
import { netTargetBook } from "@/features/copy-trade/position-gap-v3/netting";
import { strictBuyLimitPrice } from "@/features/copy-trade/position-gap-v3/price-cohort";

const TARGET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const NOW = Date.parse("2026-10-08T02:30:00.000Z");

function snapshot(
	conditions: TargetBookSnapshotV1["conditions"],
): TargetBookSnapshotV1 {
	return {
		version: 1,
		snapshotId: "snapshot-1",
		targetWallet: TARGET,
		fullRefreshAtMs: NOW - 1_000,
		updatedAtMs: NOW - 500,
		expiresAtMs: NOW + 30_000,
		complete: true,
		refreshStats: {
			kind: "full",
			discoveryRows: conditions.length * 2,
			conditionCount: conditions.length,
			dataApiCalls: 2,
			sourceComputedAt: "2026-10-08T02:29:59.000Z",
			sourceMaxSyncedBlock: 95_148_252,
		},
		conditions,
	};
}

function condition(params: {
	conditionId?: string;
	leftShares: number;
	rightShares: number;
	leftMark?: number;
	rightMark?: number;
	leftAverage?: number;
	rightAverage?: number;
}): TargetBookSnapshotV1["conditions"][number] {
	const conditionId = params.conditionId ?? "condition-1";
	return {
		conditionId,
		status: "OPEN",
		redeemable: false,
		endDate: null,
		negativeRisk: false,
		tokens: [
			{
				tokenId: `${conditionId}-yes`,
				oppositeTokenId: `${conditionId}-no`,
				outcomeIndex: 0,
				shares: params.leftShares,
				markPrice: params.leftMark ?? 0.5,
				averagePrice: params.leftAverage ?? 0.5,
			},
			{
				tokenId: `${conditionId}-no`,
				oppositeTokenId: `${conditionId}-yes`,
				outcomeIndex: 1,
				shares: params.rightShares,
				markPrice: params.rightMark ?? 0.5,
				averagePrice: params.rightAverage ?? 0.5,
			},
		],
	};
}

function input(
	book: TargetBookSnapshotV1,
	overrides: Partial<PositionGapBookInputV1> = {},
): PositionGapBookInputV1 {
	const cohorts = book.conditions.flatMap((entry) =>
		entry.tokens.map((token) => ({
			cohortId: `activation:${token.tokenId}`,
			conditionId: entry.conditionId,
			tokenId: token.tokenId,
			kind: "activation" as const,
			allowedMirrorShares: token.shares,
			acquiredMirrorShares: 0,
			availableNewBuyShares: token.shares,
			targetVwap: token.averagePrice,
		})),
	);
	const venues = book.conditions.map((entry) => ({
		conditionId: entry.conditionId,
		status: "accepting_orders" as const,
		quotes: entry.tokens.map((token) => ({
			tokenId: token.tokenId,
			bestAsk: token.markPrice,
			tickSize: 0.01,
			minOrderShares: 1,
			minOrderUsdc: 1,
		})),
	}));
	return {
		nowMs: NOW,
		snapshot: book,
		sleeveBudgetUsdc: 100,
		actualWalletCashUsdc: 110,
		confirmedBuyNotionalCashHeadroomUsdc: 100,
		confirmedSleeveHeadroomUsdc: 100,
		confirmedStrategyCapHeadroomUsdc: 100,
		confirmedAccountCapHeadroomUsdc: 100,
		confirmedPerOrderCapUsdc: 100,
		confirmedRemainingIntentCount: 8,
		maxIntents: 8,
		venues,
		cohorts,
		holdings: [],
		openBuyOrders: [],
		...overrides,
	};
}

describe("position-gap-v3 complete-set netting", () => {
	it("removes a binary complete set and retains only directional shares", () => {
		const result = netTargetBook(
			snapshot([
				condition({
					leftShares: 100,
					rightShares: 60,
					leftMark: 0.4,
					rightMark: 0.6,
				}),
			]),
			new Map([["condition-1", "accepting_orders"]]),
		);

		expect(result.eligibleNetNavUsdc).toBeCloseTo(16, 10);
		expect(result.positions).toEqual([
			expect.objectContaining({
				conditionId: "condition-1",
				tokenId: "condition-1-yes",
				netShares: 40,
				completeSetShares: 60,
			}),
		]);
	});

	it("caps activation catch-up at net economic break-even after netting", () => {
		const result = netTargetBook(
			snapshot([
				condition({
					leftShares: 100,
					rightShares: 60,
					leftAverage: 0.8,
					rightAverage: 0.1,
				}),
			]),
			new Map([["condition-1", "accepting_orders"]]),
		);

		expect(result.positions[0]).toMatchObject({
			netBreakEvenPrice: 0.65,
			activationPriceCap: 0.65,
		});
	});

	it("fails activation pricing closed when complete-set economics are nonpositive", () => {
		const result = netTargetBook(
			snapshot([
				condition({
					leftShares: 100,
					rightShares: 60,
					leftAverage: 0.2,
					rightAverage: 0.1,
				}),
			]),
			new Map([["condition-1", "accepting_orders"]]),
		);

		expect(result.positions[0]).toMatchObject({
			netBreakEvenPrice: null,
			activationPriceCap: null,
		});
	});

	it("excludes a positive residual whose target mark is zero", () => {
		const result = netTargetBook(
			snapshot([
				condition({
					leftShares: 100,
					rightShares: 60,
					leftMark: 0,
					rightMark: 0.5,
				}),
			]),
			new Map([["condition-1", "accepting_orders"]]),
		);

		expect(result.eligibleNetNavUsdc).toBe(0);
		expect(result.positions).toEqual([]);
		expect(result.ineligibleTargetPositions).toEqual([
			{
				conditionId: "condition-1",
				tokenId: "condition-1-yes",
				reason: "invalid_mark_price",
			},
		]);
	});

	it("keeps unknown venue state in NAV but removes authoritative closure", () => {
		const book = snapshot([
			condition({ conditionId: "unknown", leftShares: 10, rightShares: 0 }),
			condition({ conditionId: "closed", leftShares: 20, rightShares: 0 }),
		]);
		const result = netTargetBook(
			book,
			new Map([
				["unknown", "unknown"],
				["closed", "closed"],
			]),
		);

		expect(result.eligibleNetNavUsdc).toBe(5);
		expect(result.positions.map((position) => position.conditionId)).toEqual([
			"unknown",
		]);
	});
});

describe("position-gap-v3 strict price cohorts", () => {
	it("rests at the strict tick-floored VWAP when the ask is worse or absent", () => {
		expect(
			strictBuyLimitPrice({ targetVwap: 0.507, bestAsk: 0.7, tickSize: 0.01 }),
		).toEqual({ ok: true, price: 0.5 });
		expect(
			strictBuyLimitPrice({
				targetVwap: 0.507,
				bestAsk: null,
				tickSize: 0.01,
			}),
		).toEqual({ ok: true, price: 0.5 });
	});

	it("uses a better ask without ever crossing above target VWAP", () => {
		expect(
			strictBuyLimitPrice({
				targetVwap: 0.507,
				bestAsk: 0.493,
				tickSize: 0.01,
			}),
		).toEqual({ ok: true, price: 0.49 });
	});
});

describe("position-gap-v3 deterministic lot allocator", () => {
	function candidate(
		id: string,
		weight: number,
		maxNotionalUsdc: number,
	): PositionGapCandidateV1 {
		return {
			id,
			conditionId: `condition-${id}`,
			tokenId: `token-${id}`,
			cohortId: `cohort-${id}`,
			cohortKind: "activation",
			targetWeight: weight,
			limitPrice: 0.5,
			targetVwap: 0.5,
			maxShares: maxNotionalUsdc / 0.5,
			floorShares: 2,
			floorNotionalUsdc: 1,
		};
	}

	it("reserves floors before distributing remainder, so one large gap cannot monopolize", () => {
		const result = allocatePositionGapLots(
			[candidate("large", 0.9, 100), candidate("small", 0.1, 10)],
			11,
			8,
		);

		expect(result).toHaveLength(2);
		expect(result.reduce((sum, lot) => sum + lot.notionalUsdc, 0)).toBeCloseTo(
			11,
			8,
		);
		expect(result.every((lot) => lot.notionalUsdc >= 1)).toBe(true);
	});

	it("selects at most eight highest-weight affordable floors with stable ties", () => {
		const candidates = Array.from({ length: 10 }, (_, index) =>
			candidate(String.fromCharCode(97 + index), 1, 2),
		).reverse();
		const result = allocatePositionGapLots(candidates, 100, 8);

		expect(result).toHaveLength(8);
		expect(result.map((lot) => lot.id)).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
		]);
	});

	it("matches its declared floor-first proportional objective over generated inputs", () => {
		let seed = 0xa110ca7e;
		const random = () => {
			seed = (1664525 * seed + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};

		for (let run = 0; run < 500; run += 1) {
			const candidates = Array.from(
				{ length: 1 + Math.floor(random() * 15) },
				(_, index) => {
					const floorNotionalUsdc = 0.1 + random() * 5;
					const maxNotionalUsdc = floorNotionalUsdc + random() * 20;
					return {
						...candidate(
							String.fromCharCode(97 + index),
							random(),
							maxNotionalUsdc,
						),
						floorShares: floorNotionalUsdc / 0.5,
						floorNotionalUsdc,
					};
				},
			).reverse();
			const headroom = random() * 80;
			const maxIntents = Math.floor(random() * 12);
			const effectiveMax = Math.min(8, maxIntents);
			const ordered = [...candidates].sort(
				(left, right) =>
					right.targetWeight - left.targetWeight ||
					left.conditionId.localeCompare(right.conditionId) ||
					left.tokenId.localeCompare(right.tokenId) ||
					left.cohortId.localeCompare(right.cohortId),
			);
			const expected: PositionGapCandidateV1[] = [];
			let remaining = headroom;
			for (const entry of ordered) {
				if (expected.length >= effectiveMax) break;
				if (entry.floorNotionalUsdc > remaining + 1e-9) continue;
				expected.push(entry);
				remaining -= entry.floorNotionalUsdc;
			}

			const result = allocatePositionGapLots(
				[...candidates].reverse(),
				headroom,
				maxIntents,
			);
			const expectedSpend = Math.min(
				headroom,
				expected.reduce(
					(sum, entry) => sum + entry.maxShares * entry.limitPrice,
					0,
				),
			);

			expect(result.map((lot) => lot.id)).toEqual(
				expected.map((entry) => entry.id),
			);
			expect(
				result.reduce((sum, lot) => sum + lot.notionalUsdc, 0),
			).toBeCloseTo(expectedSpend, 8);
			for (const lot of result) {
				expect(lot.notionalUsdc + 1e-9).toBeGreaterThanOrEqual(
					lot.floorNotionalUsdc,
				);
				expect(lot.notionalUsdc).toBeLessThanOrEqual(
					lot.maxShares * lot.limitPrice + 1e-9,
				);
			}
		}
	});
});

describe("position-gap-v3 whole-book planning", () => {
	it("uses budget / eligible net NAV and never reads target cash", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(input(book, { sleeveBudgetUsdc: 25 }));

		expect(plan.status).toBe("ready");
		expect(plan.eligibleNetNavUsdc).toBe(50);
		expect(plan.scale).toBe(0.5);
		expect(plan.intents[0]).toMatchObject({
			side: "BUY",
			desiredShares: 50,
			gapShares: 50,
		});
	});

	it("treats cohort allowance as scaled provenance, never raw target shares", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const base = input(book, {
			sleeveBudgetUsdc: 100,
			confirmedPerOrderCapUsdc: 1_000,
		});
		const initial = planPositionGapBook(base);
		const largerBudget = planPositionGapBook({
			...base,
			sleeveBudgetUsdc: 150,
			confirmedSleeveHeadroomUsdc: 150,
			confirmedBuyNotionalCashHeadroomUsdc: 150,
		});
		const explicitlyIncreased = planPositionGapBook({
			...base,
			sleeveBudgetUsdc: 150,
			confirmedSleeveHeadroomUsdc: 150,
			confirmedBuyNotionalCashHeadroomUsdc: 150,
			cohorts: base.cohorts.map((cohort) => ({
				...cohort,
				allowedMirrorShares: 250,
			})),
		});

		expect(initial.scale).toBe(2);
		expect(largerBudget.scale).toBe(3);
		expect(initial.intents[0]?.desiredShares).toBe(100);
		expect(largerBudget.intents[0]?.desiredShares).toBe(100);
		expect(explicitlyIncreased.intents[0]?.desiredShares).toBe(250);
	});

	it("fails closed on expired or structurally incomplete snapshots", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const expired = planPositionGapBook({
			...input(book),
			nowMs: book.expiresAtMs,
		});
		const incomplete = planPositionGapBook(
			input({ ...book, complete: false } as unknown as TargetBookSnapshotV1),
		);

		expect(expired).toMatchObject({
			status: "blocked",
			blockReason: "stale_snapshot",
			intents: [],
		});
		expect(incomplete).toMatchObject({
			status: "blocked",
			blockReason: "invalid_input",
			intents: [],
		});
	});

	it("subtracts held and retained open shares from a cohort gap", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(
			input(book, {
				sleeveBudgetUsdc: 25,
				holdings: [
					{
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						shares: 10,
					},
				],
				openBuyOrders: [
					{
						orderId: "order-1",
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						cohortId: "activation:condition-1-yes",
						remainingShares: 5,
						reservedUsdc: 2.5,
						limitPrice: 0.5,
					},
				],
			}),
		);

		expect(plan.intents[0]).toMatchObject({
			desiredShares: 50,
			heldShares: 10,
			openShares: 5,
			gapShares: 35,
		});
	});

	it("nets mirror complete sets before measuring directional target gaps", () => {
		const book = snapshot([
			condition({ leftShares: 10, rightShares: 0, leftMark: 0.5 }),
		]);
		const base = input(book, {
			sleeveBudgetUsdc: 5,
			holdings: [
				{
					conditionId: "condition-1",
					tokenId: "condition-1-yes",
					shares: 10,
				},
				{
					conditionId: "condition-1",
					tokenId: "condition-1-no",
					shares: 10,
				},
			],
		});
		const completeSet = planPositionGapBook(base);
		const reversed = planPositionGapBook({
			...base,
			holdings: [...base.holdings].reverse(),
		});
		const partialSet = planPositionGapBook({
			...base,
			holdings: base.holdings.map((holding) =>
				holding.tokenId === "condition-1-no"
					? { ...holding, shares: 5 }
					: holding,
			),
		});

		expect(reversed).toEqual(completeSet);
		expect(completeSet.intents[0]).toMatchObject({
			tokenId: "condition-1-yes",
			heldShares: 0,
			gapShares: 10,
		});
		expect(partialSet.intents[0]).toMatchObject({
			tokenId: "condition-1-yes",
			heldShares: 5,
			gapShares: 5,
		});
	});

	it("waits instead of manufacturing a complete set across a target side switch", () => {
		const book = snapshot([
			condition({ leftShares: 10, rightShares: 0, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(
			input(book, {
				sleeveBudgetUsdc: 5,
				holdings: [
					{
						conditionId: "condition-1",
						tokenId: "condition-1-no",
						shares: 5,
					},
				],
				openBuyOrders: [
					{
						orderId: "new-side-order",
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						cohortId: "activation:condition-1-yes",
						remainingShares: 2,
						reservedUsdc: 1,
						limitPrice: 0.5,
					},
				],
			}),
		);

		expect(plan.intents).toEqual([]);
		expect(plan.cancellations).toEqual([
			expect.objectContaining({
				orderId: "new-side-order",
				reason: "opposite_hold",
			}),
		]);
		expect(plan.lockedOverweights).toEqual([
			expect.objectContaining({
				tokenId: "condition-1-no",
				excessShares: 5,
			}),
		]);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({ reason: "blocked_by_opposite_hold" }),
		);
		expect(JSON.stringify(plan)).not.toContain('"SELL"');
	});

	it("never rounds a sub-floor gap upward", () => {
		const book = snapshot([
			condition({ leftShares: 1, rightShares: 0, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(input(book, { sleeveBudgetUsdc: 0.5 }));

		expect(plan.intents).toEqual([]);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({ reason: "below_market_floor" }),
		);
	});

	it("skips a sub-$1 limit-GTC gap instead of rounding it upward", () => {
		const book = snapshot([
			condition({
				leftShares: 100,
				rightShares: 0,
				leftMark: 0.01,
				leftAverage: 0.01,
			}),
		]);
		const base = input(book, { sleeveBudgetUsdc: 0.05 });
		const plan = planPositionGapBook({
			...base,
			venues: base.venues.map((venue) => ({
				...venue,
				quotes: venue.quotes.map((quote) => ({
					...quote,
					bestAsk: null,
					minOrderShares: 5,
					minOrderUsdc: 0,
				})),
			})),
			confirmedBuyNotionalCashHeadroomUsdc: 0.05,
			confirmedSleeveHeadroomUsdc: 0.05,
			confirmedStrategyCapHeadroomUsdc: 0.05,
			confirmedAccountCapHeadroomUsdc: 0.05,
			confirmedPerOrderCapUsdc: 1,
		});

		expect(plan.intents).toEqual([]);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				reason: "below_market_floor",
				gapShares: 5,
				floorNotionalUsdc: 1,
			}),
		);
	});

	it("reports the sleeve needed for a $1 GTC without manufacturing an RN1 order", () => {
		const currentSleeve = 24.21285;
		const currentGapShares = 1.087455525259;
		const targetNavUsdc = 47_338.14592945;
		const selectedShares =
			currentGapShares / (currentSleeve / targetNavUsdc);
		const ballastShares = (targetNavUsdc - selectedShares * 0.18) / 0.5;
		const book = snapshot([
			condition({
				conditionId: "selected",
				leftShares: selectedShares,
				rightShares: 0,
				leftMark: 0.18,
				leftAverage: 0.18,
			}),
			condition({
				conditionId: "ballast",
				leftShares: ballastShares,
				rightShares: 0,
				leftMark: 0.5,
			}),
		]);
		const base = input(book, { sleeveBudgetUsdc: currentSleeve });
		const plan = planPositionGapBook({
			...base,
			venues: base.venues.map((venue) => ({
				...venue,
				quotes: venue.quotes.map((quote) => ({
					...quote,
					bestAsk: null,
					minOrderShares: 5,
					minOrderUsdc: 0,
				})),
			})),
			cohorts: base.cohorts
				.filter((cohort) => cohort.tokenId === "selected-yes")
				.map((cohort) => ({
					...cohort,
					allowedMirrorShares: currentGapShares,
				})),
		});

		expect(plan.intents).toEqual([]);
		const selected = plan.diagnostics.find(
			(row) => row.tokenId === "selected-yes",
		);
		expect(selected).toMatchObject({ reason: "below_market_floor" });
		expect(selected?.floorNotionalUsdc).toBeCloseTo(1, 10);
		expect(plan.minimumFeasibleSleeveUsdc).toBeCloseTo(
			(currentSleeve * (1 / 0.18)) / currentGapShares,
			6,
		);
	});

	it("cancels reduced open BUYs, reports filled overweight, and emits no SELL", () => {
		const book = snapshot([
			condition({ leftShares: 10, rightShares: 0, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(
			input(book, {
				sleeveBudgetUsdc: 5,
				holdings: [
					{
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						shares: 12,
					},
				],
				openBuyOrders: [
					{
						orderId: "order-1",
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						cohortId: "activation:condition-1-yes",
						remainingShares: 3,
						reservedUsdc: 1.5,
						limitPrice: 0.5,
					},
				],
			}),
		);

		expect(plan.intents).toEqual([]);
		expect(plan.cancellations).toEqual([
			expect.objectContaining({ orderId: "order-1", reason: "target_reduced" }),
		]);
		expect(plan.lockedOverweights).toEqual([
			expect.objectContaining({ excessShares: 2 }),
		]);
		expect(JSON.stringify(plan)).not.toContain('"SELL"');
	});

	it("cancels and locks a token that disappears from the target net book", () => {
		const book = snapshot([
			condition({ leftShares: 10, rightShares: 10, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(
			input(book, {
				holdings: [
					{
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						shares: 2,
					},
				],
				openBuyOrders: [
					{
						orderId: "stale-target-leg",
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						cohortId: "activation:condition-1-yes",
						remainingShares: 3,
						reservedUsdc: 1.5,
						limitPrice: 0.5,
					},
				],
			}),
		);

		expect(plan.cancellations).toEqual([
			expect.objectContaining({
				orderId: "stale-target-leg",
				reason: "target_reduced",
			}),
		]);
		expect(plan.lockedOverweights).toEqual([
			expect.objectContaining({
				tokenId: "condition-1-yes",
				excessShares: 2,
			}),
		]);
		expect(plan.intents).toEqual([]);
	});

	it("cancels an order above a lowered cohort cap without reusing its cash", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(
			input(book, {
				sleeveBudgetUsdc: 50,
				openBuyOrders: [
					{
						orderId: "too-expensive",
						conditionId: "condition-1",
						tokenId: "condition-1-yes",
						cohortId: "activation:condition-1-yes",
						remainingShares: 10,
						reservedUsdc: 6,
						limitPrice: 0.6,
					},
				],
			}),
		);

		expect(plan.cancellations).toEqual([
			expect.objectContaining({
				orderId: "too-expensive",
				reason: "price_cap_lowered",
			}),
		]);
		expect(plan.existingReservedUsdc).toBe(6);
		expect(plan.newReservedUsdc).toBe(0);
		expect(plan.intents).toEqual([]);
	});

	it("distinguishes empty asks, cash headroom, and authoritative closure", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const base = input(book, { sleeveBudgetUsdc: 50 });
		const emptyAsk = planPositionGapBook({
			...base,
			venues: base.venues.map((venue) => ({
				...venue,
				quotes: venue.quotes.map((quote) => ({ ...quote, bestAsk: null })),
			})),
		});
		const noNotionalHeadroom = planPositionGapBook({
			...base,
			actualWalletCashUsdc: 11,
			confirmedBuyNotionalCashHeadroomUsdc: 0,
		});
		const closed = planPositionGapBook({
			...base,
			venues: base.venues.map((venue) => ({ ...venue, status: "closed" })),
		});

		expect(emptyAsk.intents[0]?.limitPrice).toBe(0.5);
		expect(noNotionalHeadroom.intents).toEqual([]);
		expect(noNotionalHeadroom.actualWalletCashUsdc).toBe(11);
		expect(noNotionalHeadroom.minimumFeasibleSleeveUsdc).toBe(1);
		expect(closed.eligibleNetNavUsdc).toBe(0);
		expect(closed.intents).toEqual([]);
	});

	it("allocates only executor-confirmed notional headroom, not raw wallet cash", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const plan = planPositionGapBook(
			input(book, {
				sleeveBudgetUsdc: 50,
				actualWalletCashUsdc: 11,
				confirmedBuyNotionalCashHeadroomUsdc: 10,
			}),
		);

		expect(plan.actualWalletCashUsdc).toBe(11);
		expect(plan.confirmedBuyNotionalCashHeadroomUsdc).toBe(10);
		expect(plan.newReservedUsdc).toBeCloseTo(10, 10);
		expect(plan.remainingBuyNotionalCashHeadroomUsdc).toBeCloseTo(0, 10);
	});

	it("clips each order to per-order and remaining intent-count caps", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const base = input(book, {
			sleeveBudgetUsdc: 50,
			confirmedPerOrderCapUsdc: 3,
		});
		const clipped = planPositionGapBook(base);
		const countBlocked = planPositionGapBook({
			...base,
			confirmedRemainingIntentCount: 0,
		});

		expect(clipped.intents[0]?.notionalUsdc).toBe(3);
		expect(countBlocked.intents).toEqual([]);
	});

	it("caps a whole-book plan by the hourly count and hard maximum of eight", () => {
		const conditions = Array.from({ length: 10 }, (_, index) =>
			condition({
				conditionId: `condition-${index}`,
				leftShares: 10,
				rightShares: 0,
				leftMark: 0.5,
			}),
		);
		const base = input(snapshot(conditions), {
			sleeveBudgetUsdc: 100,
			actualWalletCashUsdc: 110,
			confirmedBuyNotionalCashHeadroomUsdc: 100,
			confirmedSleeveHeadroomUsdc: 100,
			confirmedStrategyCapHeadroomUsdc: 100,
			confirmedAccountCapHeadroomUsdc: 100,
			confirmedRemainingIntentCount: 99,
			maxIntents: 99,
		});
		const hardCapped = planPositionGapBook(base);
		const hourlyCapped = planPositionGapBook({
			...base,
			confirmedRemainingIntentCount: 3,
		});

		expect(hardCapped.intents).toHaveLength(8);
		expect(hourlyCapped.intents).toHaveLength(3);
	});

	it("emits at most one candidate per token and orders cohorts by strict cap", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const base = input(book, { sleeveBudgetUsdc: 50 });
		const cohorts = [
			{
				cohortId: "high",
				conditionId: "condition-1",
				tokenId: "condition-1-yes",
				kind: "forward" as const,
				allowedMirrorShares: 20,
				acquiredMirrorShares: 0,
				availableNewBuyShares: 20,
				targetVwap: 0.6,
			},
			{
				cohortId: "low",
				conditionId: "condition-1",
				tokenId: "condition-1-yes",
				kind: "forward" as const,
				allowedMirrorShares: 20,
				acquiredMirrorShares: 0,
				availableNewBuyShares: 20,
				targetVwap: 0.4,
			},
		];
		const forward = planPositionGapBook({ ...base, cohorts });
		const reversed = planPositionGapBook({
			...base,
			cohorts: [...cohorts].reverse(),
		});

		expect(reversed).toEqual(forward);
		expect(forward.intents).toHaveLength(1);
		expect(forward.intents[0]).toMatchObject({
			cohortId: "low",
			limitPrice: 0.4,
		});
		expect(forward.diagnostics).toContainEqual(
			expect.objectContaining({ cohortId: "high", reason: "cohort_waiting" }),
		);
	});

	it("clamps persisted cohort attribution to actual wallet holdings", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const base = input(book, { sleeveBudgetUsdc: 50 });
		const cohorts = [
			{
				cohortId: "high",
				conditionId: "condition-1",
				tokenId: "condition-1-yes",
				kind: "forward" as const,
				allowedMirrorShares: 20,
				acquiredMirrorShares: 20,
				availableNewBuyShares: 20,
				targetVwap: 0.6,
			},
			{
				cohortId: "low",
				conditionId: "condition-1",
				tokenId: "condition-1-yes",
				kind: "forward" as const,
				allowedMirrorShares: 20,
				acquiredMirrorShares: 20,
				availableNewBuyShares: 20,
				targetVwap: 0.4,
			},
		];
		const plan = planPositionGapBook({
			...base,
			cohorts,
			holdings: [
				{ conditionId: "condition-1", tokenId: "condition-1-yes", shares: 25 },
			],
		});
		const reversed = planPositionGapBook({
			...base,
			cohorts: [...cohorts].reverse(),
			holdings: [
				{ conditionId: "condition-1", tokenId: "condition-1-yes", shares: 25 },
			],
		});

		expect(reversed).toEqual(plan);
		expect(plan.intents).toHaveLength(1);
		expect(plan.intents[0]).toMatchObject({
			cohortId: "high",
			heldShares: 5,
			gapShares: 15,
		});
	});

	it("fails activation catch-up closed when complete-set break-even is nonpositive", () => {
		const book = snapshot([
			condition({
				leftShares: 100,
				rightShares: 60,
				leftMark: 0.5,
				leftAverage: 0.2,
				rightAverage: 0.1,
			}),
		]);
		const plan = planPositionGapBook(input(book));

		expect(plan.intents).toEqual([]);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				cohortId: "activation:condition-1-yes",
				reason: "invalid_cohort",
			}),
		);
	});

	it("reports an excluded zero-mark target leg instead of allocating it", () => {
		const book = snapshot([
			condition({
				leftShares: 100,
				rightShares: 60,
				leftMark: 0,
				rightMark: 0.5,
			}),
		]);
		const plan = planPositionGapBook(input(book));

		expect(plan.eligibleNetNavUsdc).toBe(0);
		expect(plan.intents).toEqual([]);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				tokenId: "condition-1-yes",
				reason: "invalid_target_mark",
			}),
		);
	});

	it("reports no sleeve-only remedy when cohort allowance cannot clear a floor", () => {
		const book = snapshot([
			condition({ leftShares: 100, rightShares: 0, leftMark: 0.5 }),
		]);
		const base = input(book, { sleeveBudgetUsdc: 50 });
		const plan = planPositionGapBook({
			...base,
			cohorts: base.cohorts.map((cohort) => ({
				...cohort,
				allowedMirrorShares: 0.5,
			})),
		});

		expect(plan.intents).toEqual([]);
		expect(plan.minimumFeasibleSleeveUsdc).toBeNull();
	});

	it("includes unknown venue positions in scale while failing their candidates closed", () => {
		const book = snapshot([
			condition({ conditionId: "known", leftShares: 10, rightShares: 0 }),
			condition({ conditionId: "unknown", leftShares: 10, rightShares: 0 }),
		]);
		const base = input(book, { sleeveBudgetUsdc: 10 });
		const plan = planPositionGapBook({
			...base,
			venues: base.venues.map((venue) =>
				venue.conditionId === "unknown"
					? { ...venue, status: "unknown", quotes: [] }
					: venue,
			),
		});

		expect(plan.eligibleNetNavUsdc).toBe(10);
		expect(plan.scale).toBe(1);
		expect(plan.intents.map((intent) => intent.conditionId)).toEqual(["known"]);
		expect(plan.diagnostics).toContainEqual(
			expect.objectContaining({
				conditionId: "unknown",
				reason: "venue_unknown",
			}),
		);
	});

	it("satisfies conservation, legality, and input-order determinism over generated books", () => {
		let seed = 0x5eed1234;
		const random = () => {
			seed = (1664525 * seed + 1013904223) >>> 0;
			return seed / 2 ** 32;
		};

		for (let run = 0; run < 500; run += 1) {
			const count = 1 + Math.floor(random() * 15);
			const conditions = Array.from({ length: count }, (_, index) =>
				condition({
					conditionId: `c-${String(index).padStart(2, "0")}`,
					leftShares: Math.floor(random() * 1_000),
					rightShares: Math.floor(random() * 1_000),
					leftMark: 0.1 + random() * 0.8,
					rightMark: 0.1 + random() * 0.8,
				}),
			);
			const budget = 1 + random() * 500;
			const base = input(snapshot(conditions), {
				sleeveBudgetUsdc: budget,
				actualWalletCashUsdc: budget * 1.1,
				confirmedBuyNotionalCashHeadroomUsdc: budget,
				confirmedSleeveHeadroomUsdc: budget,
				confirmedStrategyCapHeadroomUsdc: budget,
				confirmedAccountCapHeadroomUsdc: budget,
			});
			const forward = planPositionGapBook(base);
			const reversed = planPositionGapBook({
				...base,
				snapshot: { ...base.snapshot, conditions: [...conditions].reverse() },
				venues: [...base.venues].reverse(),
				holdings: [...base.holdings].reverse(),
				openBuyOrders: [...base.openBuyOrders].reverse(),
				cohorts: [...base.cohorts].reverse(),
			});

			expect(reversed).toEqual(forward);
			expect(forward.intents.length).toBeLessThanOrEqual(8);
			expect(
				forward.intents.reduce((sum, intent) => sum + intent.notionalUsdc, 0),
			).toBeLessThanOrEqual(budget + 1e-7);
			for (const intent of forward.intents) {
				expect(intent.side).toBe("BUY");
				expect(intent.limitPrice).toBeLessThanOrEqual(
					intent.targetVwap + 1e-12,
				);
				expect(intent.notionalUsdc + 1e-9).toBeGreaterThanOrEqual(
					intent.floorNotionalUsdc,
				);
				expect(intent.shares).toBeLessThanOrEqual(intent.gapShares + 1e-9);
			}
		}
	});
});
