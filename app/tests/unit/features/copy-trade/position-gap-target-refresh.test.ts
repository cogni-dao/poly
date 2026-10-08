// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type {
	TargetBookProviderV1,
	TargetBookSnapshotV1,
} from "@cogni/poly-market-provider";
import { describe, expect, it, vi } from "vitest";

import {
	buildPositionGapBuyIntent,
	selectPositionGapVenueCandidates,
} from "@/features/copy-trade/position-gap-actor";
import { PositionGapTargetRefreshCoordinator } from "@/features/copy-trade/position-gap-target-refresh";

const snapshot: TargetBookSnapshotV1 = {
	version: 1,
	snapshotId: "snapshot-1",
	targetWallet: "0x1111111111111111111111111111111111111111",
	fullRefreshAtMs: 1,
	updatedAtMs: 1,
	expiresAtMs: 10_000,
	complete: true,
	refreshStats: {
		kind: "full",
		discoveryRows: 0,
		conditionCount: 0,
		dataApiCalls: 1,
		sourceComputedAt: "2026-10-08T00:00:00.000Z",
		sourceMaxSyncedBlock: 1,
	},
	conditions: [],
};

function provider(): TargetBookProviderV1 {
	return {
		readFresh: vi.fn(() => snapshot),
		refreshFull: vi.fn(async () => ({ published: true, snapshot })),
		refreshDirty: vi.fn(async () => ({ published: true, snapshot })),
		invalidate: vi.fn(),
	};
}

describe("PositionGapTargetRefreshCoordinator", () => {
	it("coalesces concurrent account refreshes for one target", async () => {
		const target = provider();
		const coordinator = new PositionGapTargetRefreshCoordinator(target);

		await Promise.all([
			coordinator.refreshDirty(snapshot.targetWallet, ["condition-b"]),
			coordinator.refreshDirty(snapshot.targetWallet, ["condition-a"]),
		]);

		expect(target.refreshDirty).toHaveBeenCalledTimes(1);
		expect(target.refreshDirty).toHaveBeenCalledWith(snapshot.targetWallet, [
			"condition-a",
			"condition-b",
		]);
	});

	it("joins a second account to an already in-flight full refresh", async () => {
		let releaseRefresh!: () => void;
		const target = provider();
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		vi.mocked(target.refreshFull).mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseRefresh = () => resolve({ published: true, snapshot });
					markStarted();
				}),
		);
		const coordinator = new PositionGapTargetRefreshCoordinator(target);
		const accountA = coordinator.refreshFull(snapshot.targetWallet);
		await started;
		const accountB = coordinator.refreshFull(snapshot.targetWallet);
		releaseRefresh();

		await expect(Promise.all([accountA, accountB])).resolves.toHaveLength(2);
		expect(target.refreshFull).toHaveBeenCalledTimes(1);
	});

	it("settles thrown refreshes and permits a later retry", async () => {
		const target = provider();
		vi.mocked(target.refreshFull)
			.mockRejectedValueOnce(new Error("upstream exploded"))
			.mockResolvedValueOnce({ published: true, snapshot });
		const coordinator = new PositionGapTargetRefreshCoordinator(target);

		await expect(
			coordinator.refreshFull(snapshot.targetWallet),
		).resolves.toMatchObject({ published: false, reason: "upstream" });
		await expect(
			coordinator.refreshFull(snapshot.targetWallet),
		).resolves.toMatchObject({ published: true });
		expect(target.refreshFull).toHaveBeenCalledTimes(2);
	});
});

describe("selectPositionGapVenueCandidates", () => {
	it("bounds an RN1-sized book before any CLOB constraint reads", () => {
		const candidates = selectPositionGapVenueCandidates({
			snapshot,
			cohorts: Array.from({ length: 151 }, (_, index) => ({
				tokenId: `token-${index.toString().padStart(3, "0")}`,
				allowedMirrorShares: 10 + index,
				benchmarkTargetVwap: 0.5,
			})),
			holdings: [],
			openOrders: [],
			perOrderHeadroomUsdc: 24,
		});

		expect(candidates.size).toBe(16);
		expect(candidates.has("token-150")).toBe(true);
	});

	it("performs zero venue reads when the per-order authority cannot reach the $1 floor", () => {
		expect(
			selectPositionGapVenueCandidates({
				snapshot,
				cohorts: [
					{
						tokenId: "token",
						allowedMirrorShares: 100,
						benchmarkTargetVwap: 0.5,
					},
				],
				holdings: [],
				openOrders: [],
				perOrderHeadroomUsdc: 0.99,
			}),
		).toEqual(new Set());
	});

	it("nets mirror complete sets before deciding whether a target-side gap needs venue truth", () => {
		const binarySnapshot: TargetBookSnapshotV1 = {
			...snapshot,
			conditions: [
				{
					conditionId: "condition",
					status: "OPEN",
					redeemable: false,
					endDate: null,
					negativeRisk: false,
					tokens: [
						{
							tokenId: "yes",
							oppositeTokenId: "no",
							outcomeIndex: 0,
							shares: 5,
							markPrice: 0.5,
							averagePrice: 0.5,
						},
						{
							tokenId: "no",
							oppositeTokenId: "yes",
							outcomeIndex: 1,
							shares: 0,
							markPrice: 0.5,
							averagePrice: 0.5,
						},
					],
				},
			],
		};

		expect(
			selectPositionGapVenueCandidates({
				snapshot: binarySnapshot,
				cohorts: [
					{
						tokenId: "yes",
						allowedMirrorShares: 5,
						benchmarkTargetVwap: 0.5,
					},
				],
				holdings: [
					{ conditionId: "condition", tokenId: "yes", shares: 10 },
					{ conditionId: "condition", tokenId: "no", shares: 10 },
				],
				openOrders: [],
				perOrderHeadroomUsdc: 24,
			}),
		).toEqual(new Set(["yes"]));
	});
});

describe("buildPositionGapBuyIntent", () => {
	it("exposes only a BUY limit-GTC intent to the executor seam", () => {
		const intent = buildPositionGapBuyIntent({
			marketId: "prediction-market:polymarket:condition",
			outcome: "0",
			notionalUsdc: 2,
			limitPrice: 0.4,
			clientOrderId: "client",
			tokenId: "yes",
			conditionId: "condition",
			cohortKey: "activation:yes",
		});

		expect(intent.side).toBe("BUY");
		expect(intent.attributes).toMatchObject({
			orderType: "GTC",
			placement: "limit",
			position_gap_version: "3",
		});
	});
});
