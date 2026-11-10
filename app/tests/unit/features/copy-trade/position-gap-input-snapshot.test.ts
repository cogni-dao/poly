// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { createHash } from "node:crypto";
import type { TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
import { describe, expect, it } from "vitest";
import { selectPlannerRelevantCohorts } from "@/features/copy-trade/position-gap-actor";
import { planPositionGapBook } from "@/features/copy-trade/position-gap-v3/batch-plan";
import type {
	PositionGapBookInputV1,
	PositionGapPriceCohortV1,
} from "@/features/copy-trade/position-gap-v3/model";

/**
 * bug.5051 round 2: the input snapshot persisted per 30s run must carry only
 * facts the pure planner can read. Retired cohort history (~42k RN1 rows) is
 * not one of them, and dropping it must not change any decision.
 */

const NOW = Date.parse("2026-11-10T22:00:00.000Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function buildBook(positionCount: number): TargetBookSnapshotV1 {
	const conditions = Array.from({ length: positionCount }, (_, index) => {
		const conditionId = `0x${sha(`condition-${index}`)}`;
		return {
			conditionId,
			status: "OPEN" as const,
			redeemable: false,
			endDate: null,
			negativeRisk: false,
			tokens: [
				{
					tokenId: `${conditionId}-yes`,
					oppositeTokenId: `${conditionId}-no`,
					outcomeIndex: 0,
					shares: 100 + index,
					markPrice: 0.5,
					averagePrice: 0.45,
				},
				{
					tokenId: `${conditionId}-no`,
					oppositeTokenId: `${conditionId}-yes`,
					outcomeIndex: 1,
					shares: 0,
					markPrice: 0.5,
					averagePrice: 0.5,
				},
			],
		};
	});
	return {
		version: 1,
		snapshotId: "snapshot-rn1",
		targetWallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
		fullRefreshAtMs: NOW - 1_000,
		updatedAtMs: NOW - 500,
		expiresAtMs: NOW + 30_000,
		complete: true,
		refreshStats: {
			kind: "full",
			discoveryRows: positionCount * 2,
			conditionCount: positionCount,
			dataApiCalls: 2,
			sourceComputedAt: "2026-11-10T21:59:59.000Z",
			sourceMaxSyncedBlock: 95_148_252,
		},
		conditions,
	};
}

function cohort(
	conditionId: string,
	tokenId: string,
	index: number,
): PositionGapPriceCohortV1 {
	return {
		cohortId: sha(`cohort-${index}`),
		conditionId,
		tokenId,
		kind: index % 9 === 0 ? "activation" : "forward",
		allowedMirrorShares: 12.345678901234,
		acquiredMirrorShares: index % 7 === 0 ? 3.210987654321 : 0,
		availableNewBuyShares: index % 5 === 0 ? 9.135802469136 : 0,
		targetVwap: 0.3 + (index % 40) / 100,
	};
}

describe("bug.5051 position-gap input snapshot size", () => {
	const positions = 300;
	const totalCohorts = 42_340;
	const book = buildBook(positions);
	const cohorts: PositionGapPriceCohortV1[] = [];
	for (let index = 0; index < totalCohorts; index++) {
		// ~12% of retained history belongs to tokens still in the target book.
		const active = index % 8 === 0;
		const conditionId = active
			? (book.conditions[index % positions]?.conditionId as string)
			: `0x${sha(`retired-condition-${index}`)}`;
		cohorts.push(cohort(conditionId, `${conditionId}-yes`, index));
	}
	const retiredOpenOrderCohort = cohorts[1] as PositionGapPriceCohortV1;
	const openBuyOrders = [
		{
			orderId: "order-retired",
			conditionId: retiredOpenOrderCohort.conditionId,
			tokenId: retiredOpenOrderCohort.tokenId,
			cohortId: retiredOpenOrderCohort.cohortId,
			remainingShares: 5,
			reservedUsdc: 2,
			limitPrice: 0.4,
		},
	];
	const pruned = selectPlannerRelevantCohorts({
		snapshot: book,
		openBuyOrders,
		cohorts,
	});

	function plannerInput(
		list: readonly PositionGapPriceCohortV1[],
	): PositionGapBookInputV1 {
		return {
			nowMs: NOW,
			snapshot: book,
			sleeveBudgetUsdc: 1_000,
			targetCashPusdUsdc: 5_000,
			targetCashUsdcEUsdc: 0,
			targetCashObservedBlock: book.refreshStats.sourceMaxSyncedBlock,
			actualWalletCashUsdc: 1_100,
			confirmedBuyNotionalCashHeadroomUsdc: 1_000,
			confirmedSleeveHeadroomUsdc: 1_000,
			confirmedStrategyCapHeadroomUsdc: 1_000,
			confirmedAccountCapHeadroomUsdc: 1_000,
			confirmedPerOrderCapUsdc: 100,
			confirmedRemainingIntentCount: 8,
			maxIntents: 8,
			venues: book.conditions.map((entry) => ({
				conditionId: entry.conditionId,
				status: "accepting_orders" as const,
				quotes: entry.tokens.map((token) => ({
					tokenId: token.tokenId,
					bestAsk: 0.5,
					tickSize: 0.01,
					minOrderShares: 5,
					minOrderUsdc: 1,
				})),
			})),
			cohorts: list,
			holdings: [],
			openBuyOrders,
			unmanagedBuyExposure: [],
		};
	}

	it("keeps only target-book and open-order cohorts, in original order", () => {
		expect(pruned.length).toBeLessThan(totalCohorts / 4);
		expect(pruned).toContain(retiredOpenOrderCohort);
		const order = pruned.map((entry) => cohorts.indexOf(entry));
		expect(order).toEqual([...order].sort((left, right) => left - right));
		const activeKeys = new Set(
			book.conditions.flatMap((entry) =>
				entry.tokens.map((token) => `${entry.conditionId}|${token.tokenId}`),
			),
		);
		for (const entry of pruned) {
			const isOrderPair =
				entry.conditionId === retiredOpenOrderCohort.conditionId &&
				entry.tokenId === retiredOpenOrderCohort.tokenId;
			expect(
				isOrderPair || activeKeys.has(`${entry.conditionId}|${entry.tokenId}`),
			).toBe(true);
		}
	});

	it("leaves the pure planner's plan byte-identical", () => {
		const full = planPositionGapBook(plannerInput(cohorts));
		const reduced = planPositionGapBook(plannerInput(pruned));
		expect(JSON.stringify(reduced)).toBe(JSON.stringify(full));
		expect(full.intents.length).toBeGreaterThan(0);
	});

	it("bounds the persisted canonical input by planner-visible facts", () => {
		const fullBytes = JSON.stringify(plannerInput(cohorts)).length;
		const prunedBytes = JSON.stringify(plannerInput(pruned)).length;
		console.info(
			`bug.5051 canonical_input bytes: full=${fullBytes} pruned=${prunedBytes} cohorts ${cohorts.length}->${pruned.length}`,
		);
		expect(fullBytes).toBeGreaterThan(10_000_000);
		expect(prunedBytes).toBeLessThan(fullBytes / 3);
	});
});
