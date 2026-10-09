// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type {
	TargetBookProviderV1,
	TargetBookSnapshotV1,
} from "@cogni/poly-market-provider";
import { ClobRejectionError } from "@cogni/poly-market-provider/adapters/polymarket";
import { describe, expect, it, vi } from "vitest";

import {
	buildPositionGapBuyIntent,
	knownNoOrder,
	requireConfirmedSafetyCancellation,
	selectPositionGapVenueCandidates,
	startPositionGapActor,
} from "@/features/copy-trade/position-gap-actor";
import { recoverableHardClobRejectionCode } from "@/features/copy-trade/position-gap-placement-errors";
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

	it("keeps a sub-$1 GTC candidate so venue share floors remain observable", () => {
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
		).toEqual(new Set(["token"]));
	});

	it("keeps an under-share-floor gap for bounded floor and minimum-sleeve diagnostics", () => {
		expect(
			selectPositionGapVenueCandidates({
				snapshot,
				cohorts: [
					{
						tokenId: "rn1-token",
						allowedMirrorShares: 1.087455525259,
						benchmarkTargetVwap: 0.18,
					},
				],
				holdings: [],
				openOrders: [],
				perOrderHeadroomUsdc: 5,
			}),
		).toEqual(new Set(["rn1-token"]));
	});

	it("prioritizes a mechanically feasible cheap share lot inside the 16-token bound", () => {
		const candidates = selectPositionGapVenueCandidates({
			snapshot,
			cohorts: [
				...Array.from({ length: 16 }, (_, index) => ({
					tokenId: `expensive-${index.toString().padStart(2, "0")}`,
					allowedMirrorShares: 4,
					benchmarkTargetVwap: 0.9,
				})),
				{
					tokenId: "cheap-five-share-lot",
					allowedMirrorShares: 5,
					benchmarkTargetVwap: 0.01,
				},
			],
			holdings: [],
			openOrders: [],
			perOrderHeadroomUsdc: 5,
		});

		expect(candidates.size).toBe(16);
		expect(candidates.has("cheap-five-share-lot")).toBe(true);
		expect(candidates.has("expensive-15")).toBe(false);
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
			targetWallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
			lineage: {
				algorithm_id: "poly.copy-mirror.position-gap",
				algorithm_version_id: `sha256:${"a".repeat(64)}`,
				config_hash: `sha256:${"b".repeat(64)}`,
				input_snapshot_id: `sha256:${"c".repeat(64)}`,
				assignment_id: "assignment",
				correlation_id: "client",
			},
		});

		expect(intent.side).toBe("BUY");
			expect(intent.attributes).toMatchObject({
			orderType: "GTC",
			placement: "limit",
			position_gap_version: "3",
			algorithm_id: "poly.copy-mirror.position-gap",
			target_wallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
		});
	});

	it("distinguishes explicit no-order rejection from ambiguous transport failure", () => {
		expect(
			knownNoOrder(
				new ClobRejectionError("rejected", {
					error_code: "insufficient_balance",
					reason: "rejected",
					response_keys: [],
				}),
			),
		).toBe(true);
		expect(knownNoOrder(new Error("connection reset after submit"))).toBe(false);
	});

	it("recognizes structured CLOB rejection details across bundle identities", () => {
		const crossBundleError = Object.assign(
			new Error(
				'PolymarketClobAdapter.placeOrder: CLOB rejected order (error_code=insufficient_allowance, response_keys=[success,errorMsg], reason="insufficient_allowance")',
			),
			{
				name: "ClobRejectionError",
				details: {
					error_code: "insufficient_allowance",
					response_keys: ["success", "errorMsg"],
					reason: "insufficient_allowance",
				},
			},
		);

		expect(crossBundleError).not.toBeInstanceOf(ClobRejectionError);
		expect(knownNoOrder(crossBundleError)).toBe(true);
		expect(
			knownNoOrder(
				Object.assign(
					new Error(
						"invalid amount for a marketable BUY order ($0.22729), min size: $1 (https://clob.polymarket.com/order)",
					),
					{
						name: "p",
						details: {
							error_code: "below_min_order_size",
							response_keys: [],
							reason: "below_min_order_size",
						},
					},
				),
			),
		).toBe(true);
		expect(
			knownNoOrder(
				Object.assign(new Error("connection reset after submit"), {
					details: {
						error_code: "insufficient_allowance",
						response_keys: [],
					},
				}),
			),
		).toBe(false);
	});

	it("recovers only canonical durable hard rejections", () => {
		expect(
			recoverableHardClobRejectionCode(
				'PolymarketClobAdapter.placeOrder: CLOB rejected order (error_code=insufficient_allowance, response_keys=[success,errorMsg], reason="insufficient_allowance", clob_error="allowance is not enough")',
			),
		).toBe("insufficient_allowance");
		expect(
			recoverableHardClobRejectionCode(
				'PolymarketClobAdapter.placeOrder: CLOB rejected order (error_code=insufficient_balance, response_keys=[success,errorMsg], reason="insufficient_balance", clob_error="not enough balance")',
			),
		).toBe("insufficient_balance");
		expect(
			recoverableHardClobRejectionCode(
				"invalid amount for a marketable BUY order ($0.22729), min size: $1 (https://clob.polymarket.com/order)",
			),
		).toBe("below_min_order_size");
		expect(
			recoverableHardClobRejectionCode(
				"PolymarketClobAdapter.placeOrder: CLOB rejected order (error_code=insufficient_allowance)",
			),
		).toBeNull();
		expect(
			recoverableHardClobRejectionCode(
				"not enough balance / allowance: allowance is not enough",
			),
		).toBeNull();
		expect(
			recoverableHardClobRejectionCode("connection reset after submit"),
		).toBeNull();
	});

	it("blocks a safety stop until the venue confirms cancellation", async () => {
		const cancelBuy = vi.fn(async () => undefined);
		const getBuy = vi
			.fn()
			.mockResolvedValueOnce({ not_found: true })
			.mockResolvedValueOnce({
				found: {
					order_id: "order",
					client_order_id: "client",
					status: "canceled",
					submitted_at: "2026-10-08T00:00:00.000Z",
				},
			});
		const markCancelConfirmed = vi.fn(async () => undefined);
		const ledgerMarkCanceled = vi.fn(async () => undefined);
		const input = {
			execution: { cancelBuy, getBuy },
			store: {
				markCancelConfirmed,
				markPlacementReceipt: vi.fn(async () => undefined),
			},
			ledger: {
				markCanceled: ledgerMarkCanceled,
				markOrderId: vi.fn(async () => undefined),
			},
			cancellation: { id: "cancel", orderId: "order" },
			active: {
				id: "buy",
				runId: "run",
				clientOrderId: "client",
				orderId: "order",
				conditionId: "condition",
				tokenId: "token",
				cohortKey: "cohort",
				marketId: "market",
				outcome: "0",
				shares: 2,
				filledShares: 0,
				notionalUsdc: 1,
				limitPrice: 0.5,
				status: "open",
			},
		};

		await expect(requireConfirmedSafetyCancellation(input)).rejects.toThrow(
			"unconfirmed",
		);
		expect(markCancelConfirmed).not.toHaveBeenCalled();
		await expect(requireConfirmedSafetyCancellation(input)).resolves.toBeUndefined();
		expect(markCancelConfirmed).toHaveBeenCalledOnce();
		expect(ledgerMarkCanceled).toHaveBeenCalledOnce();
	});

	it("recovers a hard rejection before disable cancels an accepted BUY", async () => {
		const recoverKnownRejectedAmbiguities = vi.fn(async () => [
			{
				id: "rejected-buy",
				clientOrderId: "rejected-client",
				errorCode: "insufficient_allowance" as const,
			},
		]);
		const openBuy = {
			id: "open-buy",
			runId: "open-run",
			clientOrderId: "open-client",
			orderId: "open-order",
			conditionId: "condition",
			tokenId: "token",
			cohortKey: "cohort",
			marketId: "prediction-market:polymarket:condition",
			outcome: "0",
			shares: 2,
			filledShares: 0,
			notionalUsdc: 1,
			limitPrice: 0.5,
			status: "open",
		};
		const loadPlannerState = vi.fn(async () => ({
			cohorts: [],
			openBuyOrders: [
				{
					orderId: "open-order",
					conditionId: "condition",
					tokenId: "token",
					cohortId: "cohort",
					remainingShares: 2,
					reservedUsdc: 1,
					limitPrice: 0.5,
				},
			],
			activeBuys: [openBuy],
		}));
		const cancelBuy = vi.fn(async () => undefined);
		const getBuy = vi
			.fn()
			.mockResolvedValueOnce({
				found: {
					order_id: "open-order",
					client_order_id: "open-client",
					status: "open",
					submitted_at: "2026-10-08T00:00:00.000Z",
				},
			})
			.mockResolvedValueOnce({
				found: {
					order_id: "open-order",
					client_order_id: "open-client",
					status: "canceled",
					submitted_at: "2026-10-08T00:00:00.000Z",
				},
			});
		const markCancelConfirmed = vi.fn(async () => undefined);
		const persistPlan = vi.fn(async () => ({
			runId: "safety-run",
			buys: [],
			cancellations: [
				{
					id: "cancel-action",
					orderId: "open-order",
					relatedBuyActionId: "open-buy",
				},
			],
		}));
		const never = new Promise<number>(() => undefined);
		const databaseCause = Object.assign(
			new Error("violates check constraint"),
			{ code: "23514" },
		);
		const repairTargetWalletLineage = vi.fn(async () => {
			throw new Error("Failed query", { cause: databaseCause });
		});
		const loggerWarn = vi.fn();
		const handle = startPositionGapActor({
			implementationRevision: "0123456789abcdef0123456789abcdef01234567",
			scope: {
				billingAccountId: "billing-account",
				createdByUserId: "user",
				targetId: "target",
			},
			targetWallet: "0x1111111111111111111111111111111111111111",
			configRevision: "revision",
			configuredBudgetUsdc: 10,
			positionGapBudgetGroup: {
				positionGapTargetCount: 1,
				explicitBudgetTotalUsdc: 10,
				automaticTargetCount: 0,
				unbudgetedTargetCount: 0,
			},
			source: {
				fetchSince: vi.fn(),
				subscribeWake: vi.fn(() => () => undefined),
			},
			refresh: {} as never,
			store: {
				recoverSubmittingAsAmbiguous: vi.fn(() => never),
				repairTargetWalletLineage,
				recoverKnownRejectedAmbiguities,
				loadPlannerState,
				loadOrderBindings: vi.fn(async () =>
					new Map([
						[
							"open-client",
							{ mode: "paper" as const, status: "open" },
						],
					]),
				),
				loadAccountBuyExposure: vi.fn(async () => [
					{
						clientOrderId: "open-client",
						orderId: "open-order",
						mode: "paper" as const,
						conditionId: "condition",
						tokenId: "token",
						remainingShares: 1,
					},
				]),
				reconcileLedgerTerminals: vi.fn(async () => 0),
				loadLastSnapshot: vi.fn(async () => snapshot),
				persistPlan,
				markPlacementReceipt: vi.fn(async () => undefined),
				markCancelConfirmed,
				finishRun: vi.fn(async () => undefined),
			} as never,
			ledger: {
				markOrderId: vi.fn(async () => undefined),
				markCanceled: vi.fn(async () => undefined),
			} as never,
			getExecutionMode: vi.fn(async () => "paper" as const),
			executionForMode: () => ({
				placeBuy: vi.fn(),
				cancelBuy,
				getBuy,
				getMarketConstraints: vi.fn(),
				listOpenOrders: vi.fn(async () => []),
			}),
			fillEvidence: {
				getWalletAddress: vi.fn(),
				listActivity: vi.fn(),
				listPositions: vi.fn(),
			},
			getWalletCashUsdc: vi.fn(async () => 20),
			getTargetCashUsdc: vi.fn(async () => ({
				pusdUsdc: 0,
				usdcEUsdc: 0,
				observedBlock: 1,
			})),
			getAuthoritativeHoldings: vi.fn(),
			logger: {
				debug: vi.fn(),
				info: vi.fn(),
				warn: loggerWarn,
				error: vi.fn(),
				child() {
					return this;
				},
			},
			setInterval: vi.fn(() => 1 as never),
			clearInterval: vi.fn(),
		});

		await expect(handle.stop()).resolves.toBeUndefined();
		expect(recoverKnownRejectedAmbiguities).toHaveBeenCalledOnce();
		expect(repairTargetWalletLineage).toHaveBeenCalledWith(
			{
				billingAccountId: "billing-account",
				createdByUserId: "user",
				targetId: "target",
			},
			"0x1111111111111111111111111111111111111111",
			"paper",
		);
		expect(loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "poly.position_gap.v3.target_lineage_repair_failed",
				err: "Failed query",
				err_cause: "violates check constraint",
				err_code: "23514",
			}),
			expect.any(String),
		);
		expect(cancelBuy).toHaveBeenCalledWith("open-order");
		expect(markCancelConfirmed).toHaveBeenCalledWith("cancel-action");
		expect(
			recoverKnownRejectedAmbiguities.mock.invocationCallOrder[0],
		).toBeLessThan(cancelBuy.mock.invocationCallOrder[0] ?? 0);
	});
});
