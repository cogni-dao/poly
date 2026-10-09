// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
	type PositionGapCohortState,
	projectPositionGapCohorts,
} from "@/features/copy-trade/position-gap-cohorts";

const position = {
	conditionId: "condition-1",
	tokenId: "token-yes",
	marketId: "prediction-market:polymarket:condition-1",
	outcome: "YES",
	netShares: 100,
	activationPriceCap: 0.4,
};

function cohort(
	overrides: Partial<PositionGapCohortState>,
): PositionGapCohortState {
	return {
		id: "cohort-1",
		cohortKey: "cohort-1",
		sourceKind: "target_buy",
		conditionId: position.conditionId,
		tokenId: position.tokenId,
		marketId: position.marketId,
		outcome: position.outcome,
		targetDeltaShares: 100,
		scaleAtCreation: 0.1,
		allowedMirrorShares: 10,
		benchmarkTargetVwap: 0.4,
		acquiredShares: 0,
		openOrderShares: 0,
		remainingShares: 10,
		createdAtMs: 1,
		...overrides,
	};
}

function base(overrides: Record<string, unknown> = {}) {
	return {
		existing: [] as PositionGapCohortState[],
		netTargetPositions: [position],
		activity: [],
		snapshotId: "snapshot-1",
		snapshotHash: "hash-1",
		configRevision: "revision-1",
		previousBudgetUsdc: null,
		budgetUsdc: 40,
		allocationDenominatorUsdc: 400,
		scale: 0.1,
		activation: false,
		nowMs: 1_000,
		...overrides,
	};
}

describe("projectPositionGapCohorts", () => {
	it("creates one deterministic activation cohort and keeps sub-floor entitlement", () => {
		const first = projectPositionGapCohorts(base({ activation: true }));
		const second = projectPositionGapCohorts(base({ activation: true }));

		expect(first.creations).toHaveLength(1);
		expect(first.creations[0]).toMatchObject({
			sourceKind: "activation",
			allowedMirrorShares: 10,
			remainingShares: 10,
			benchmarkTargetVwap: 0.4,
		});
		expect(second.creations[0]?.cohortKey).toBe(first.creations[0]?.cohortKey);
	});

	it("backfills a position omitted from the first complete snapshot exactly once", () => {
		const latePosition = {
			...position,
			conditionId: "condition-2",
			tokenId: "token-late",
			marketId: "prediction-market:polymarket:condition-2",
			netShares: 50,
			activationPriceCap: 0.3,
		};
		const initial = projectPositionGapCohorts(base({ activation: true }));
		const persistedInitial = cohort({
			id: "persisted-initial",
			cohortKey: initial.creations[0]?.cohortKey,
			sourceKind: "activation",
		});
		const later = projectPositionGapCohorts(
			base({
				activation: true,
				existing: [persistedInitial],
				netTargetPositions: [position, latePosition],
				snapshotId: "snapshot-2",
				snapshotHash: "hash-2",
				nowMs: 2_000,
			}),
		);

		expect(later.creations).toHaveLength(1);
		expect(later.creations[0]).toMatchObject({
			sourceKind: "activation",
			conditionId: latePosition.conditionId,
			tokenId: latePosition.tokenId,
			allowedMirrorShares: 5,
			benchmarkTargetVwap: 0.3,
		});
		expect(
			later.cohorts.find((entry) => entry.id === persistedInitial.id),
		).toEqual(persistedInitial);

		const persistedLate = cohort({
			id: "persisted-late",
			cohortKey: later.creations[0]?.cohortKey,
			sourceKind: "activation",
			conditionId: latePosition.conditionId,
			tokenId: latePosition.tokenId,
			marketId: latePosition.marketId,
			targetDeltaShares: latePosition.netShares,
			allowedMirrorShares: 5,
			remainingShares: 5,
			benchmarkTargetVwap: 0.3,
			createdAtMs: 2_000,
		});
		const replay = projectPositionGapCohorts(
			base({
				activation: true,
				existing: [persistedInitial, persistedLate],
				netTargetPositions: [position, latePosition],
				snapshotId: "snapshot-3",
				snapshotHash: "hash-3",
				nowMs: 3_000,
			}),
		);

		expect(replay.creations).toEqual([]);
	});

	it("does not manufacture entitlement when scale rises without BUY or config growth", () => {
		const result = projectPositionGapCohorts(
			base({ existing: [cohort({})], scale: 0.2 }),
		);

		expect(result.creations).toEqual([]);
		expect(result.cohorts[0]?.allowedMirrorShares).toBe(10);
	});

	it("fails closed when the complete-set-netted activation cap is unavailable", () => {
		const result = projectPositionGapCohorts(
			base({
				activation: true,
				netTargetPositions: [{ ...position, activationPriceCap: null }],
			}),
		);

		expect(result.creations).toEqual([]);
	});

	it("creates a stable cohort for an observed BUY and dedupes replay", () => {
		const activity = [
			{
				fillId: "data-api:trade-1",
				side: "BUY" as const,
				conditionId: position.conditionId,
				tokenId: position.tokenId,
				marketId: position.marketId,
				outcome: position.outcome,
				shares: 20,
				price: 0.35,
				observedAtMs: 2_000,
			},
		];
		const first = projectPositionGapCohorts(base({ activity }));
		const replay = projectPositionGapCohorts(
			base({
				activity,
				existing: [
					cohort({
						id: "persisted",
						cohortKey: first.creations[0]?.cohortKey,
						allowedMirrorShares: 2,
						remainingShares: 2,
					}),
				],
			}),
		);

		expect(first.creations[0]).toMatchObject({
			sourceKind: "target_buy",
			targetDeltaShares: 20,
			allowedMirrorShares: 2,
			benchmarkTargetVwap: 0.35,
		});
		expect(replay.creations).toEqual([]);
	});

	it("reduces highest benchmark then newest and never reduces acquired shares", () => {
		const result = projectPositionGapCohorts(
			base({
				netTargetPositions: [{ ...position, netShares: 50 }],
				existing: [
					cohort({
						id: "low",
						cohortKey: "low",
						benchmarkTargetVwap: 0.3,
						createdAtMs: 1,
					}),
					cohort({
						id: "high-old",
						cohortKey: "high-old",
						benchmarkTargetVwap: 0.7,
						allowedMirrorShares: 4,
						remainingShares: 4,
						createdAtMs: 2,
					}),
					cohort({
						id: "high-new",
						cohortKey: "high-new",
						benchmarkTargetVwap: 0.7,
						allowedMirrorShares: 3,
						acquiredShares: 2,
						remainingShares: 1,
						createdAtMs: 3,
					}),
				],
			}),
		);

		expect(result.reductions.map((entry) => entry.cohortId)).toEqual([
			"high-new",
			"high-old",
			"low",
		]);
		expect(
			result.cohorts.find((entry) => entry.id === "high-new"),
		).toMatchObject({
			allowedMirrorShares: 2,
			acquiredShares: 2,
		});
	});

	it("creates explicit config-increase cohorts instead of raising old rows", () => {
		const result = projectPositionGapCohorts(
			base({
				existing: [cohort({})],
				previousBudgetUsdc: 40,
				budgetUsdc: 60,
				scale: 0.15,
				configRevision: "revision-2",
			}),
		);

		expect(result.creations).toHaveLength(1);
		expect(result.creations[0]).toMatchObject({
			sourceKind: "config_increase",
			allowedMirrorShares: 5,
		});
		expect(
			result.cohorts.find((entry) => entry.id === "cohort-1"),
		).toMatchObject({ allowedMirrorShares: 10 });
	});
});
