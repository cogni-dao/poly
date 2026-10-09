// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres proof for lineage-scoped copy-target V2 hydration. */
import { randomUUID } from "node:crypto";
import {
	polyTraderCurrentPositions,
	polyTraderIngestionCursors,
	polyTraderPositionSnapshots,
	polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import type { TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
import type {
	PolymarketDataApiClient,
	PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dbTargetSource } from "@/features/copy-trade/target-source";
import {
	hydrateCopyTargetPositions,
	persistPositionGapTargetSnapshot,
	readCopyTargetPositionCohorts,
} from "@/features/wallet-analysis/server/copy-target-position-hydration-service";
import {
	COPY_TARGET_POSITION_CURSOR_SOURCE,
} from "@/features/wallet-analysis/server/position-observation-sources";
import {
	buildBoundedMarketExposureWithCoverage,
	readFullComparisonCoverageCounts,
} from "@/features/wallet-analysis/server/market-exposure-service";
import {
	billingAccounts,
	polyCopyTradeFills,
	polyCopyTradeTargets,
	polyWalletConnections,
	polyWalletGrants,
	users,
} from "@/shared/db/schema";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const suffix = randomUUID().replaceAll("-", "");
const USER_ID = `target-hydration-user-${suffix}`;
const BILLING_ID = `target-hydration-billing-${suffix}`;
const OUR_WALLET = `0x${"31".repeat(20)}` as `0x${string}`;
const PAPER_LOCAL_WALLET = `0x${"32".repeat(20)}` as `0x${string}`;
const TARGET_WALLET = `0x${"42".repeat(20)}` as `0x${string}`;
const CONDITION = `0x${"a1".repeat(32)}`;
const UNRELATED_CONDITION = `0x${"b2".repeat(32)}`;
const ZERO_VALUE_CONDITION = `0x${"d4".repeat(32)}`;
const PAPER_CONDITION = `0x${"e6".repeat(32)}`;
const MISMATCHED_TARGET_CONDITION = `0x${"f7".repeat(32)}`;
const LOCAL_TOKEN = "111111";
const OPPOSITE_TOKEN = "222222";
const UNRELATED_TOKEN = "333333";
const ZERO_VALUE_TOKEN = "444444";
const PAPER_TOKEN = "555555";
const MISMATCHED_TARGET_TOKEN = "666666";
const POSITION_GAP_WALLET = `0x${"73".repeat(20)}` as `0x${string}`;
const POSITION_GAP_CONDITION_A = `0x${"74".repeat(32)}`;
const POSITION_GAP_CONDITION_B = `0x${"75".repeat(32)}`;
const POSITION_GAP_TOKEN_A = "777777";
const POSITION_GAP_OPPOSITE_A = "888888";
const POSITION_GAP_TOKEN_B = "999999";
const POSITION_GAP_OPPOSITE_B = "101010";
const POSITION_GAP_FUTURE_CONDITION = `0x${"76".repeat(32)}`;
const POSITION_GAP_FUTURE_TOKEN = "111213";

function positionGapSnapshot(input: {
	snapshotId: string;
	updatedAt: string;
	sharesA: number;
	includeB: boolean;
}): TargetBookSnapshotV1 {
	const updatedAtMs = Date.parse(input.updatedAt);
	const conditions: Array<TargetBookSnapshotV1["conditions"][number]> = [
		{
			conditionId: POSITION_GAP_CONDITION_A,
			status: "OPEN",
			redeemable: false,
			endDate: "2027-01-01T00:00:00.000Z",
			negativeRisk: false,
			tokens: [
				{
					tokenId: POSITION_GAP_TOKEN_A,
					oppositeTokenId: POSITION_GAP_OPPOSITE_A,
					outcomeIndex: 0,
					shares: input.sharesA,
					averagePrice: 0.4,
					markPrice: 0.75,
				},
				{
					tokenId: POSITION_GAP_OPPOSITE_A,
					oppositeTokenId: POSITION_GAP_TOKEN_A,
					outcomeIndex: 1,
					shares: 0,
					averagePrice: 0,
					markPrice: 0.25,
				},
			],
		},
	];
	if (input.includeB) {
		conditions.push({
			conditionId: POSITION_GAP_CONDITION_B,
			status: "OPEN",
			redeemable: false,
			endDate: null,
			negativeRisk: true,
			tokens: [
				{
					tokenId: POSITION_GAP_TOKEN_B,
					oppositeTokenId: POSITION_GAP_OPPOSITE_B,
					outcomeIndex: 0,
					shares: 20,
					averagePrice: 0.2,
					markPrice: 0.3,
				},
				{
					tokenId: POSITION_GAP_OPPOSITE_B,
					oppositeTokenId: POSITION_GAP_TOKEN_B,
					outcomeIndex: 1,
					shares: 0,
					averagePrice: 0,
					markPrice: 0.7,
				},
			],
		});
	}
	return {
		version: 1,
		snapshotId: input.snapshotId,
		targetWallet: POSITION_GAP_WALLET,
		fullRefreshAtMs: updatedAtMs,
		updatedAtMs,
		expiresAtMs: updatedAtMs + 60_000,
		complete: true,
		refreshStats: {
			kind: "full",
			discoveryRows: conditions.length,
			conditionCount: conditions.length,
			dataApiCalls: 2,
			sourceComputedAt: input.updatedAt,
			sourceMaxSyncedBlock: Math.floor(updatedAtMs / 1_000),
		},
		conditions,
	};
}

function position(
	tokenId: string,
	conditionId = CONDITION,
): PolymarketUserPosition {
	const exact = tokenId === LOCAL_TOKEN;
	return {
		proxyWallet: TARGET_WALLET,
		asset: tokenId,
		conditionId,
		size: exact ? 100 : 25,
		avgPrice: exact ? 0.4 : 0.2,
		initialValue: exact ? 40 : 5,
		currentValue: exact ? 75 : 4,
		cashPnl: exact ? 35 : -1,
		percentPnl: exact ? 87.5 : -20,
		totalBought: exact ? 100 : 25,
		realizedPnl: 0,
		percentRealizedPnl: 0,
		curPrice: exact ? 0.75 : 0.16,
		redeemable: false,
		mergeable: false,
		title: "Hydration market",
		slug: "hydration-market",
		icon: null,
		eventId: "hydration-event",
		eventSlug: "hydration-event",
		outcome: exact ? "YES" : "NO",
		outcomeIndex: exact ? 0 : 1,
		oppositeOutcome: exact ? "NO" : "YES",
		oppositeAsset: exact ? OPPOSITE_TOKEN : LOCAL_TOKEN,
		endDate: "2027-01-01T00:00:00Z",
		negativeRisk: false,
	};
}

function localExecutionPosition(input: {
	conditionId: string;
	tokenId: string;
	status: "open" | "closed";
}): WalletExecutionPosition {
	return {
		positionId: `${input.conditionId}:${input.tokenId}`,
		conditionId: input.conditionId,
		asset: input.tokenId,
		marketTitle: "Hydration market",
		marketSlug: "hydration-market",
		eventSlug: null,
		marketUrl: null,
		outcome: "YES",
		status: input.status,
		openedAt: "2026-10-01T00:00:00.000Z",
		closedAt: input.status === "closed" ? "2026-10-02T00:00:00.000Z" : null,
		resolvesAt: null,
		heldMinutes: 1,
		entryPrice: 0.5,
		currentPrice: input.status === "closed" ? 0 : 0.6,
		size: 10,
		currentValue: input.status === "closed" ? 0 : 6,
		pnlUsd: input.status === "closed" ? -5 : 1,
		pnlPct: input.status === "closed" ? -100 : 20,
		timeline: [],
		events: [],
	};
}

describe("lineage-scoped copy-target V2 hydration", () => {
	const db = getSeedDb();
	let ourTraderWalletId = "";
	let paperTraderWalletId = "";
	let targetTraderWalletId = "";

	beforeAll(async () => {
		await db.insert(users).values({
			id: USER_ID,
			name: USER_ID,
			walletAddress: OUR_WALLET,
		});
		await db.insert(billingAccounts).values({
			id: BILLING_ID,
			ownerUserId: USER_ID,
			balanceCredits: 0n,
		});
		const [connection] = await db
			.insert(polyWalletConnections)
			.values({
				billingAccountId: BILLING_ID,
				createdByUserId: USER_ID,
				privyWalletId: `privy-${suffix}`,
				address: OUR_WALLET,
				funderAddress: OUR_WALLET,
				clobApiKeyCiphertext: Buffer.from("component-test"),
				encryptionKeyId: "component-test",
				custodialConsentAcceptedAt: new Date(),
				custodialConsentActorKind: "user",
				custodialConsentActorId: USER_ID,
			})
			.returning({ id: polyWalletConnections.id });
		if (!connection) throw new Error("connection seed failed");
		await db.insert(polyWalletGrants).values({
			billingAccountId: BILLING_ID,
			walletConnectionId: connection.id,
			createdByUserId: USER_ID,
			scopes: ["poly:trade:buy", "poly:trade:sell"],
			perOrderUsdcCap: "10.00",
			dailyUsdcCap: "100.00",
			hourlyFillsCap: 100,
			expiresAt: new Date("2099-01-01T00:00:00Z"),
		});
		const [ourWallet] = await db
			.insert(polyTraderWallets)
			.values({
				walletAddress: OUR_WALLET,
				kind: "cogni_wallet",
				label: "Our wallet",
			})
			.returning({ id: polyTraderWallets.id });
		const [targetWallet] = await db
			.insert(polyTraderWallets)
			.values({
				walletAddress: TARGET_WALLET,
				kind: "copy_target",
				label: "Target",
			})
			.returning({ id: polyTraderWallets.id });
		if (!ourWallet || !targetWallet) throw new Error("wallet seed failed");
		ourTraderWalletId = ourWallet.id;
		targetTraderWalletId = targetWallet.id;
		const [paperWallet] = await db
			.insert(polyTraderWallets)
			.values({
				walletAddress: PAPER_LOCAL_WALLET,
				kind: "paper_wallet",
				label: "Our paper wallet",
			})
			.returning({ id: polyTraderWallets.id });
		if (!paperWallet) throw new Error("paper wallet seed failed");
		paperTraderWalletId = paperWallet.id;

		await db.insert(polyTraderCurrentPositions).values([
			{
				traderWalletId: ourWallet.id,
				conditionId: CONDITION,
				tokenId: LOCAL_TOKEN,
				shares: "10",
				costBasisUsdc: "5",
				currentValueUsdc: "6",
				avgPrice: "0.5",
				contentHash: `our-${suffix}`,
				lastObservedAt: new Date(),
				raw: { title: "Hydration market", outcome: "YES" },
			},
			{
				traderWalletId: ourWallet.id,
				conditionId: ZERO_VALUE_CONDITION,
				tokenId: ZERO_VALUE_TOKEN,
				active: false,
				shares: "10",
				costBasisUsdc: "5",
				currentValueUsdc: "0",
				avgPrice: "0.5",
				contentHash: `our-zero-${suffix}`,
				lastObservedAt: new Date("2025-01-01T00:00:00Z"),
				raw: { title: "Zero-mark held market", outcome: "YES" },
			},
			{
				traderWalletId: ourWallet.id,
				conditionId: PAPER_CONDITION,
				tokenId: PAPER_TOKEN,
				shares: "10",
				costBasisUsdc: "5",
				currentValueUsdc: "6",
				avgPrice: "0.5",
				contentHash: `our-paper-${suffix}`,
				lastObservedAt: new Date(),
			},
		]);
		await db.insert(polyTraderCurrentPositions).values({
			traderWalletId: paperWallet.id,
			conditionId: PAPER_CONDITION,
			tokenId: PAPER_TOKEN,
			shares: "10",
			costBasisUsdc: "5",
			currentValueUsdc: "6",
			avgPrice: "0.5",
			contentHash: `our-paper-wallet-${suffix}`,
			lastObservedAt: new Date(),
			raw: { title: "Paper hydration market", outcome: "YES" },
		});
		await db.insert(polyCopyTradeTargets).values({
			billingAccountId: BILLING_ID,
			createdByUserId: USER_ID,
			targetWallet: TARGET_WALLET,
		});
		const targetId = targetIdFromWallet(TARGET_WALLET);
		await db.insert(polyCopyTradeFills).values([
			{
				billingAccountId: BILLING_ID,
				createdByUserId: USER_ID,
				targetId,
				fillId: `data-api:0x${"c3".repeat(32)}:${LOCAL_TOKEN}:BUY:1791320000000`,
				marketId: CONDITION,
				observedAt: new Date(),
				clientOrderId: `hydration-${suffix}`,
				orderId: `order-${suffix}`,
				status: "filled",
				positionLifecycle: "open",
				shares: "10",
				price: "0.5",
				feesUsdc: "0",
				attributes: {
					target_wallet: TARGET_WALLET,
					condition_id: CONDITION,
					token_id: LOCAL_TOKEN,
					filled_size_usdc: 5,
					position_gap_version: "3",
					realized_fill_source: "clob_associated_trades",
				},
			},
			{
				billingAccountId: BILLING_ID,
				createdByUserId: USER_ID,
				targetId,
				fillId: `data-api:0x${"e6".repeat(32)}:${PAPER_TOKEN}:BUY:1791320000002`,
				marketId: PAPER_CONDITION,
				observedAt: new Date(),
				clientOrderId: `hydration-paper-${suffix}`,
				orderId: `order-paper-${suffix}`,
				status: "filled",
				positionLifecycle: "open",
				mode: "paper",
				shares: "10",
				price: "0.5",
				feesUsdc: "0",
				attributes: {
					target_wallet: TARGET_WALLET,
					condition_id: PAPER_CONDITION,
					token_id: PAPER_TOKEN,
					filled_size_usdc: 5,
				},
			},
			{
				billingAccountId: BILLING_ID,
				createdByUserId: USER_ID,
				targetId,
				fillId: `data-api:0x${"e5".repeat(32)}:${ZERO_VALUE_TOKEN}:BUY:1791320000001`,
				marketId: ZERO_VALUE_CONDITION,
				observedAt: new Date(),
				clientOrderId: `hydration-zero-${suffix}`,
				orderId: `order-zero-${suffix}`,
				status: "filled",
				positionLifecycle: "loser",
				shares: "10",
				price: "0.5",
				feesUsdc: "0",
				attributes: {
					target_wallet: TARGET_WALLET,
					condition_id: ZERO_VALUE_CONDITION,
					token_id: ZERO_VALUE_TOKEN,
					filled_size_usdc: 5,
				},
			},
		]);

		// Opposite-only target fact proves condition-level matching is not enough.
		const opposite = position(OPPOSITE_TOKEN);
		await db.insert(polyTraderPositionSnapshots).values({
			traderWalletId: targetWallet.id,
			conditionId: CONDITION,
			tokenId: OPPOSITE_TOKEN,
			shares: opposite.size.toFixed(8),
			costBasisUsdc: opposite.initialValue.toFixed(8),
			currentValueUsdc: opposite.currentValue.toFixed(8),
			avgPrice: opposite.avgPrice.toFixed(8),
			contentHash: `opposite-${suffix}`,
			capturedAt: new Date(),
			raw: opposite as unknown as Record<string, unknown>,
		});
		const paperOnly = position(PAPER_TOKEN, PAPER_CONDITION);
		await db.insert(polyTraderPositionSnapshots).values({
			traderWalletId: targetWallet.id,
			conditionId: PAPER_CONDITION,
			tokenId: PAPER_TOKEN,
			shares: paperOnly.size.toFixed(8),
			costBasisUsdc: paperOnly.initialValue.toFixed(8),
			currentValueUsdc: paperOnly.currentValue.toFixed(8),
			avgPrice: paperOnly.avgPrice.toFixed(8),
			contentHash: `paper-only-${suffix}`,
			capturedAt: new Date(),
			raw: paperOnly as unknown as Record<string, unknown>,
		});
		await db.insert(polyTraderCurrentPositions).values([
			{
				traderWalletId: targetWallet.id,
				conditionId: PAPER_CONDITION,
				tokenId: PAPER_TOKEN,
				shares: paperOnly.size.toFixed(8),
				costBasisUsdc: paperOnly.initialValue.toFixed(8),
				currentValueUsdc: paperOnly.currentValue.toFixed(8),
				avgPrice: paperOnly.avgPrice.toFixed(8),
				contentHash: `paper-only-${suffix}`,
				lastObservedAt: new Date(),
				raw: paperOnly as unknown as Record<string, unknown>,
			},
			{
				traderWalletId: targetWallet.id,
				conditionId: CONDITION,
				tokenId: OPPOSITE_TOKEN,
				shares: opposite.size.toFixed(8),
				costBasisUsdc: opposite.initialValue.toFixed(8),
				currentValueUsdc: opposite.currentValue.toFixed(8),
				avgPrice: opposite.avgPrice.toFixed(8),
				contentHash: `opposite-${suffix}`,
				lastObservedAt: new Date(),
				raw: opposite as unknown as Record<string, unknown>,
			},
			{
				traderWalletId: targetWallet.id,
				conditionId: UNRELATED_CONDITION,
				tokenId: UNRELATED_TOKEN,
				shares: "7",
				costBasisUsdc: "3",
				currentValueUsdc: "4",
				avgPrice: "0.4",
				contentHash: `unrelated-${suffix}`,
				lastObservedAt: new Date(),
			},
		]);
	});

	afterAll(async () => {
		await db
			.delete(polyCopyTradeFills)
			.where(eq(polyCopyTradeFills.billingAccountId, BILLING_ID));
		await db
			.delete(polyCopyTradeTargets)
			.where(eq(polyCopyTradeTargets.billingAccountId, BILLING_ID));
		await db
			.delete(polyWalletConnections)
			.where(eq(polyWalletConnections.billingAccountId, BILLING_ID));
		await db
			.delete(polyTraderWallets)
			.where(eq(polyTraderWallets.id, ourTraderWalletId));
		await db
			.delete(polyTraderWallets)
			.where(eq(polyTraderWallets.id, paperTraderWalletId));
		await db
			.delete(polyTraderWallets)
			.where(eq(polyTraderWallets.id, targetTraderWalletId));
		await db.delete(billingAccounts).where(eq(billingAccounts.id, BILLING_ID));
		await db.delete(users).where(eq(users.id, USER_ID));
	});

	it("rejects target-wallet attributes that disagree with deterministic target lineage", async () => {
		const mismatchedTargetId = randomUUID();
		await db.insert(polyTraderCurrentPositions).values({
			traderWalletId: ourTraderWalletId,
			conditionId: MISMATCHED_TARGET_CONDITION,
			tokenId: MISMATCHED_TARGET_TOKEN,
			shares: "10",
			costBasisUsdc: "5",
			currentValueUsdc: "6",
			avgPrice: "0.5",
			contentHash: `our-mismatched-${suffix}`,
			lastObservedAt: new Date(),
		});
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: BILLING_ID,
			createdByUserId: USER_ID,
			targetId: mismatchedTargetId,
			fillId: `data-api:0x${"f7".repeat(32)}:${MISMATCHED_TARGET_TOKEN}:BUY:1791320000003`,
			marketId: MISMATCHED_TARGET_CONDITION,
			observedAt: new Date(),
			clientOrderId: `hydration-mismatched-${suffix}`,
			orderId: `order-mismatched-${suffix}`,
			status: "filled",
			positionLifecycle: "open",
			mode: "live",
			shares: "10",
			price: "0.5",
			feesUsdc: "0",
			attributes: {
				target_wallet: TARGET_WALLET,
				condition_id: MISMATCHED_TARGET_CONDITION,
				token_id: MISMATCHED_TARGET_TOKEN,
				filled_size_usdc: 5,
			},
		});
		try {
			await expect(readCopyTargetPositionCohorts(db)).rejects.toThrow(
				"invalid copy-target position cohort lineage",
			);
		} finally {
			await db
				.delete(polyCopyTradeFills)
				.where(eq(polyCopyTradeFills.targetId, mismatchedTargetId));
			await db
				.delete(polyTraderCurrentPositions)
				.where(
					and(
						eq(polyTraderCurrentPositions.traderWalletId, ourTraderWalletId),
						eq(
							polyTraderCurrentPositions.conditionId,
							MISMATCHED_TARGET_CONDITION,
						),
					),
				);
		}
	});

	it("does not hydrate a signer address when the canonical funder is absent", async () => {
		await db
			.update(polyWalletConnections)
			.set({ funderAddress: null })
			.where(eq(polyWalletConnections.billingAccountId, BILLING_ID));
		try {
			expect(await readCopyTargetPositionCohorts(db)).toEqual([]);
		} finally {
			await db
				.update(polyWalletConnections)
				.set({ funderAddress: OUR_WALLET })
				.where(eq(polyWalletConnections.billingAccountId, BILLING_ID));
		}
	});

	it("requires exact condition+token and publishes only complete scoped cohorts", async () => {
		const cohorts = await readCopyTargetPositionCohorts(db);
		expect(cohorts).toEqual([
			{
				targetWallet: TARGET_WALLET,
				conditions: [CONDITION, ZERO_VALUE_CONDITION],
				exactLocalKeys: [
					{ conditionId: CONDITION, tokenId: LOCAL_TOKEN },
					{ conditionId: ZERO_VALUE_CONDITION, tokenId: ZERO_VALUE_TOKEN },
				],
			},
		]);
		const before = await readFullComparisonCoverageCounts({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: OUR_WALLET,
			connectionKind: "privy_live",
		});
		expect(
			before.find((row) => row.entity === "positions" && row.status === "live"),
		).toMatchObject({ eligible: 2, comparable: 1 });
		const paperBefore = await readFullComparisonCoverageCounts({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: PAPER_LOCAL_WALLET,
			connectionKind: "paper",
		});
		expect(
			paperBefore.find(
				(row) => row.entity === "positions" && row.status === "live",
			),
		).toMatchObject({ eligible: 1, comparable: 1 });

		const listUserPositionsV2 = vi
			.fn()
			.mockResolvedValueOnce([
				{
					...position(LOCAL_TOKEN),
					currentValue: 0,
					cashPnl: -40,
					percentPnl: -100,
					curPrice: 0,
					redeemable: true,
				},
				position(OPPOSITE_TOKEN),
				{
					...position(ZERO_VALUE_TOKEN, ZERO_VALUE_CONDITION),
					initialValue: 0,
				},
			])
			.mockResolvedValueOnce([]);
		const logger = { info: vi.fn(), warn: vi.fn() };
		const client = {
			listUserPositionsV2,
		} as unknown as PolymarketDataApiClient;
		await db.insert(polyTraderIngestionCursors).values({
			traderWalletId: targetTraderWalletId,
			source: "data-api-positions",
			status: "partial",
			errorMessage: "omission_over_cap",
		});

		const first = await hydrateCopyTargetPositions({
			db,
			client,
			logger: logger as never,
		});
		expect(first).toEqual({ cohorts: 1, conditions: 2, rows: 3, errors: 0 });
		expect(listUserPositionsV2).toHaveBeenLastCalledWith(TARGET_WALLET, {
			conditions: [CONDITION, ZERO_VALUE_CONDITION],
		});
		const cursors = await db
			.select({
				source: polyTraderIngestionCursors.source,
				status: polyTraderIngestionCursors.status,
				lastSuccessAt: polyTraderIngestionCursors.lastSuccessAt,
			})
			.from(polyTraderIngestionCursors)
			.where(
				eq(polyTraderIngestionCursors.traderWalletId, targetTraderWalletId),
			);
		expect(cursors).toEqual(
			expect.arrayContaining([
				{
					source: COPY_TARGET_POSITION_CURSOR_SOURCE,
					status: "ok",
					lastSuccessAt: expect.any(Date),
				},
				{
					source: "data-api-positions",
					status: "partial",
					lastSuccessAt: null,
				},
			]),
		);
		const after = await readFullComparisonCoverageCounts({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: OUR_WALLET,
			connectionKind: "privy_live",
		});
		expect(
			after.find((row) => row.entity === "positions" && row.status === "live"),
		).toMatchObject({ eligible: 2, comparable: 2 });
		expect(
			after.find(
				(row) => row.entity === "positions" && row.status === "closed",
			),
		).toMatchObject({ eligible: 1, comparable: 0 });
		const [zeroEntry] = await db
			.select({ costBasisUsdc: polyTraderCurrentPositions.costBasisUsdc })
			.from(polyTraderCurrentPositions)
			.where(
				and(
					eq(polyTraderCurrentPositions.traderWalletId, targetTraderWalletId),
					eq(polyTraderCurrentPositions.conditionId, ZERO_VALUE_CONDITION),
					eq(polyTraderCurrentPositions.tokenId, ZERO_VALUE_TOKEN),
				),
			);
		expect(zeroEntry?.costBasisUsdc).toBe("0.00000000");
		const bounded = await buildBoundedMarketExposureWithCoverage({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: OUR_WALLET,
			connectionKind: "privy_live",
			livePositions: [
				localExecutionPosition({
					conditionId: CONDITION,
					tokenId: LOCAL_TOKEN,
					status: "open",
				}),
				localExecutionPosition({
					conditionId: PAPER_CONDITION,
					tokenId: PAPER_TOKEN,
					status: "open",
				}),
			],
			closedPositions: [
				localExecutionPosition({
					conditionId: ZERO_VALUE_CONDITION,
					tokenId: ZERO_VALUE_TOKEN,
					status: "closed",
				}),
			],
		});
		expect(bounded.positionClassifications).toContainEqual({
			conditionId: CONDITION,
			tokenId: LOCAL_TOKEN,
			status: "live",
			result: "comparable",
		});
		const redeemableLine = bounded.market.groups
			.flatMap((group) => group.lines)
			.find((line) => line.conditionId === CONDITION);
		const exactRedeemableLeg = redeemableLine?.participants
			.filter((participant) => participant.side === "copy_target")
			.flatMap((participant) => [participant.primary, participant.hedge])
			.find((leg) => leg?.tokenId === LOCAL_TOKEN);
		expect(exactRedeemableLeg).toMatchObject({
			costBasisUsdc: 40,
			currentValueUsdc: 0,
			lifecycle: "active",
		});
		expect(bounded.positionClassifications).toContainEqual({
			conditionId: ZERO_VALUE_CONDITION,
			tokenId: ZERO_VALUE_TOKEN,
			status: "closed",
			result: "target_entry_unavailable",
		});
		const zeroEntryLine = bounded.market.groups
			.flatMap((group) => group.lines)
			.find((line) => line.conditionId === ZERO_VALUE_CONDITION);
		expect(zeroEntryLine).toMatchObject({
			targetEntryValueUsdc: null,
			targetValueUsdc: 4,
			edgeGapPct: null,
		});
		expect(
			bounded.market.groups.find((group) =>
				group.lines.some((line) => line.conditionId === ZERO_VALUE_CONDITION),
			)?.targetEntryValueUsdc,
		).toBeNull();

		const disabledAt = new Date();
		await db
			.update(polyCopyTradeTargets)
			.set({ disabledAt })
			.where(eq(polyCopyTradeTargets.billingAccountId, BILLING_ID));
		await db.insert(polyCopyTradeTargets).values({
			billingAccountId: BILLING_ID,
			createdByUserId: USER_ID,
			targetWallet: TARGET_WALLET,
			disabledAt,
		});

		const executionTargets = await dbTargetSource({
			appDb: db as never,
			serviceDb: db as never,
		}).listAllActive();
		expect(
			executionTargets.some((target) => target.billingAccountId === BILLING_ID),
		).toBe(false);
		expect(await readCopyTargetPositionCohorts(db)).toEqual(cohorts);

		const disabledCoverage = await readFullComparisonCoverageCounts({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: OUR_WALLET,
			connectionKind: "privy_live",
		});
		expect(
			disabledCoverage.find(
				(row) => row.entity === "positions" && row.status === "live",
			),
		).toMatchObject({ eligible: 2, comparable: 1, source_ambiguous: false });
		const disabledPaperCoverage = await readFullComparisonCoverageCounts({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: PAPER_LOCAL_WALLET,
			connectionKind: "paper",
		});
		expect(
			disabledPaperCoverage.find(
				(row) => row.entity === "positions" && row.status === "live",
			),
		).toMatchObject({ eligible: 1, comparable: 1, source_ambiguous: false });
		const disabledPreview = await buildBoundedMarketExposureWithCoverage({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: OUR_WALLET,
			connectionKind: "privy_live",
			livePositions: [
				localExecutionPosition({
					conditionId: CONDITION,
					tokenId: LOCAL_TOKEN,
					status: "open",
				}),
				localExecutionPosition({
					conditionId: PAPER_CONDITION,
					tokenId: PAPER_TOKEN,
					status: "open",
				}),
			],
			closedPositions: [],
		});
		expect(disabledPreview.positionClassifications).toContainEqual({
			conditionId: CONDITION,
			tokenId: LOCAL_TOKEN,
			status: "live",
			result: "comparable",
		});
		expect(disabledPreview.positionClassifications).toContainEqual({
			conditionId: PAPER_CONDITION,
			tokenId: PAPER_TOKEN,
			status: "live",
			result: "no_target_position",
		});
		expect(
			disabledPreview.market.groups
				.flatMap((group) => group.lines)
				.find((line) => line.conditionId === CONDITION),
		).toMatchObject({ targetEntryValueUsdc: 45, targetValueUsdc: 4 });
		const disabledTarget = disabledPreview.market.groups
			.flatMap((group) => group.lines)
			.find((line) => line.conditionId === CONDITION)
			?.participants.find((participant) => participant.side === "copy_target");
		expect(disabledTarget?.hedge).toMatchObject({ tokenId: OPPOSITE_TOKEN });

		const omitted = await hydrateCopyTargetPositions({
			db,
			client,
			logger: logger as never,
		});
		expect(omitted).toEqual({
			cohorts: 1,
			conditions: 2,
			rows: 0,
			errors: 0,
		});
		expect(logger.warn).not.toHaveBeenCalled();
		const selectedRows = await db
			.select({
				tokenId: polyTraderCurrentPositions.tokenId,
				active: polyTraderCurrentPositions.active,
			})
			.from(polyTraderCurrentPositions)
			.where(
				and(
					eq(polyTraderCurrentPositions.traderWalletId, targetTraderWalletId),
					eq(polyTraderCurrentPositions.conditionId, CONDITION),
				),
			);
		expect(selectedRows).toEqual(
			expect.arrayContaining([
				{ tokenId: LOCAL_TOKEN, active: false },
				{ tokenId: OPPOSITE_TOKEN, active: false },
			]),
		);
		const afterOmission = await readFullComparisonCoverageCounts({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: OUR_WALLET,
			connectionKind: "privy_live",
		});
		expect(
			afterOmission.find(
				(row) => row.entity === "positions" && row.status === "live",
			),
		).toMatchObject({ eligible: 2, comparable: 0 });
		expect(
			afterOmission.find(
				(row) => row.entity === "positions" && row.status === "closed",
			),
		).toMatchObject({ eligible: 1, comparable: 0 });
		const boundedAfterOmission = await buildBoundedMarketExposureWithCoverage({
			db,
			billingAccountId: BILLING_ID,
			walletAddress: OUR_WALLET,
			connectionKind: "privy_live",
			livePositions: [],
			closedPositions: [
				localExecutionPosition({
					conditionId: ZERO_VALUE_CONDITION,
					tokenId: ZERO_VALUE_TOKEN,
					status: "closed",
				}),
			],
		});
		expect(boundedAfterOmission.positionClassifications).toContainEqual({
			conditionId: ZERO_VALUE_CONDITION,
			tokenId: ZERO_VALUE_TOKEN,
			status: "closed",
			result: "target_entry_unavailable",
		});
		expect(
			boundedAfterOmission.market.groups
				.flatMap((group) => group.lines)
				.find((line) => line.conditionId === ZERO_VALUE_CONDITION),
		).toMatchObject({
			targetEntryValueUsdc: null,
			targetValueUsdc: 4,
		});
		const [unrelated] = await db
			.select({ active: polyTraderCurrentPositions.active })
			.from(polyTraderCurrentPositions)
			.where(
				and(
					eq(polyTraderCurrentPositions.traderWalletId, targetTraderWalletId),
					eq(polyTraderCurrentPositions.conditionId, UNRELATED_CONDITION),
					eq(polyTraderCurrentPositions.tokenId, UNRELATED_TOKEN),
				),
			);
		expect(unrelated?.active).toBe(true);
	});

	it("projects complete Position-gap books monotonically into shared target facts", async () => {
		const newer = positionGapSnapshot({
			snapshotId: `position-gap-newer-${suffix}`,
			updatedAt: "2026-10-09T10:00:00.000Z",
			sharesA: 100,
			includeB: true,
		});
		const first = await persistPositionGapTargetSnapshot({
			db,
			snapshot: newer,
		});
		expect(first).toEqual({
			applied: true,
			positions: 2,
			snapshotId: newer.snapshotId,
		});

		const [wallet] = await db
			.select({ id: polyTraderWallets.id })
			.from(polyTraderWallets)
			.where(eq(polyTraderWallets.walletAddress, POSITION_GAP_WALLET));
		if (!wallet)
			throw new Error("Position-gap target wallet was not persisted");

		try {
			const firstCurrent = await db
				.select({
					conditionId: polyTraderCurrentPositions.conditionId,
					tokenId: polyTraderCurrentPositions.tokenId,
					shares: polyTraderCurrentPositions.shares,
					costBasisUsdc: polyTraderCurrentPositions.costBasisUsdc,
					currentValueUsdc: polyTraderCurrentPositions.currentValueUsdc,
					active: polyTraderCurrentPositions.active,
				})
				.from(polyTraderCurrentPositions)
				.where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
			expect(firstCurrent).toEqual(
				expect.arrayContaining([
					{
						conditionId: POSITION_GAP_CONDITION_A,
						tokenId: POSITION_GAP_TOKEN_A,
						shares: "100.00000000",
						costBasisUsdc: "40.00000000",
						currentValueUsdc: "75.00000000",
						active: true,
					},
					{
						conditionId: POSITION_GAP_CONDITION_B,
						tokenId: POSITION_GAP_TOKEN_B,
						shares: "20.00000000",
						costBasisUsdc: "4.00000000",
						currentValueUsdc: "6.00000000",
						active: true,
					},
				]),
			);

			const older = positionGapSnapshot({
				snapshotId: `position-gap-older-${suffix}`,
				updatedAt: "2026-10-09T09:59:00.000Z",
				sharesA: 1,
				includeB: false,
			});
			await expect(
				persistPositionGapTargetSnapshot({ db, snapshot: older }),
			).resolves.toEqual({
				applied: false,
				positions: 1,
				snapshotId: older.snapshotId,
			});
			const afterOlder = await db
				.select({
					tokenId: polyTraderCurrentPositions.tokenId,
					shares: polyTraderCurrentPositions.shares,
					active: polyTraderCurrentPositions.active,
				})
				.from(polyTraderCurrentPositions)
				.where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
			expect(afterOlder).toEqual(
				expect.arrayContaining([
					{
						tokenId: POSITION_GAP_TOKEN_A,
						shares: "100.00000000",
						active: true,
					},
					{
						tokenId: POSITION_GAP_TOKEN_B,
						shares: "20.00000000",
						active: true,
					},
				]),
			);

			const latest = positionGapSnapshot({
				snapshotId: `position-gap-latest-${suffix}`,
				updatedAt: "2026-10-09T10:01:00.000Z",
				sharesA: 125,
				includeB: false,
			});
			await db.insert(polyTraderCurrentPositions).values({
				traderWalletId: wallet.id,
				conditionId: POSITION_GAP_FUTURE_CONDITION,
				tokenId: POSITION_GAP_FUTURE_TOKEN,
				shares: "1.00000000",
				costBasisUsdc: "0.50000000",
				currentValueUsdc: "0.60000000",
				avgPrice: "0.50000000",
				contentHash: `future-${suffix}`,
				lastObservedAt: new Date("2026-10-09T10:02:00.000Z"),
			});
			await expect(
				persistPositionGapTargetSnapshot({ db, snapshot: latest }),
			).resolves.toMatchObject({
				applied: true,
				snapshotId: latest.snapshotId,
			});
			const finalCurrent = await db
				.select({
					tokenId: polyTraderCurrentPositions.tokenId,
					shares: polyTraderCurrentPositions.shares,
					active: polyTraderCurrentPositions.active,
				})
				.from(polyTraderCurrentPositions)
				.where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
			expect(finalCurrent).toEqual(
				expect.arrayContaining([
					{
						tokenId: POSITION_GAP_TOKEN_A,
						shares: "125.00000000",
						active: true,
					},
					{
						tokenId: POSITION_GAP_TOKEN_B,
						shares: "20.00000000",
						active: false,
					},
					{
						tokenId: POSITION_GAP_FUTURE_TOKEN,
						shares: "1.00000000",
						active: true,
					},
				]),
			);
			const snapshots = await db
				.select({ tokenId: polyTraderPositionSnapshots.tokenId })
				.from(polyTraderPositionSnapshots)
				.where(eq(polyTraderPositionSnapshots.traderWalletId, wallet.id));
			expect(snapshots).toHaveLength(3);
			const [cursor] = await db
				.select({
					lastSeenAt: polyTraderIngestionCursors.lastSeenAt,
					lastSeenNativeId: polyTraderIngestionCursors.lastSeenNativeId,
					status: polyTraderIngestionCursors.status,
				})
				.from(polyTraderIngestionCursors)
				.where(
					and(
						eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
						eq(
							polyTraderIngestionCursors.source,
							COPY_TARGET_POSITION_CURSOR_SOURCE,
						),
					),
				);
			expect(cursor).toEqual({
				lastSeenAt: new Date(latest.updatedAtMs),
				lastSeenNativeId: latest.snapshotId,
				status: "ok",
			});
		} finally {
			await db
				.delete(polyTraderWallets)
				.where(eq(polyTraderWallets.id, wallet.id));
		}
	});
});
