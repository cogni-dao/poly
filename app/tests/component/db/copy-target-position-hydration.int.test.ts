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
import { noopLogger, noopMetrics, type OrderReceipt, type TargetBookSnapshotV1 } from "@cogni/poly-market-provider";
import { createPolyTradeExecutorFactory } from "@/bootstrap/capabilities/poly-trade-executor";
import { createExecutionVenueResolver, createPaperVenue, derivePaperAccountAddress } from "@/features/paper-accounts";
import { readActivePaperAccounts, syncPaperTraderWallets } from "@/features/wallet-analysis/server/paper-fact-source";
import { createOrderLedger } from "@/features/trading/order-ledger";
import {
  PolymarketDataApiClient,
  type PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq, sql } from "drizzle-orm";
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
const ORPHAN_PAPER_WALLET = `0x${"32".repeat(20)}` as `0x${string}`;
const PAPER_LOCAL_WALLET = derivePaperAccountAddress(BILLING_ID);
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
    const paperConnection = randomUUID();

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
					side: "BUY",
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
    await db.insert(polyWalletConnections).values({ id: paperConnection, billingAccountId: BILLING_ID,
      createdByUserId: USER_ID, kind: "paper", address: PAPER_LOCAL_WALLET, funderAddress: PAPER_LOCAL_WALLET,
      paperSeedUsdc: "100", tradingApprovalsReadyAt: new Date(), custodialConsentAcceptedAt: new Date(),
      custodialConsentActorKind: "user", custodialConsentActorId: USER_ID });
    await db.insert(polyWalletGrants).values({ billingAccountId: BILLING_ID, walletConnectionId: paperConnection,
      createdByUserId: USER_ID, scopes: ["poly:trade:buy"], perOrderUsdcCap: "10", dailyUsdcCap: "1000", hourlyFillsCap: 1000 });
    const native: OrderReceipt = { order_id: `order-paper-${suffix}`, client_order_id: `hydration-paper-${suffix}`,
      status: "filled", filled_size_usdc: 5, total_shares: 10, fill_price: .5, fees_usdc: 0,
      submitted_at: new Date().toISOString(), attributes: { market: PAPER_CONDITION, tokenId: PAPER_TOKEN, side: "BUY", sizeMatched: 10 } };
    const nativeTransport = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://paper.retained-hydration.test");
      expect(url.pathname).toBe(`/orders/${native.order_id}`);
      expect(url.searchParams.get("account_id")).toBe(paperConnection);
      return Response.json(native);
    });
    try {
      const resolver = createExecutionVenueResolver({ db });
      expect(await resolver(BILLING_ID)).toBe("live");
      const factory = createPolyTradeExecutorFactory({ logger: noopLogger as never, metrics: noopMetrics,
        paperSidecarUrl: "http://paper.retained-hydration.test", paperVenue: createPaperVenue({ db }), resolveExecutionVenue: resolver });
      // This is a historical PAPER binding; normal mixed-account dispatch stays LIVE.
      const executor = await factory.getPolyTradeExecutorForVenue(BILLING_ID, "paper");
      const actual = await executor.getOrder(native.order_id);
      if (!("found" in actual)) throw new Error("retained hydration paper native receipt absent");
      const ledger = createOrderLedger({ db, logger: noopLogger as never, resolveExecutionMode: resolver });
      const accepted = await ledger.markOrderId({ client_order_id: native.client_order_id, receipt: actual.found });
      if (!accepted) throw new Error("retained hydration paper observation absent");
      expect(accepted.accepted).toBe(true);
      await syncPaperTraderWallets(db, await readActivePaperAccounts(db, noopLogger));
    } finally { nativeTransport.mockRestore(); }
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

  it("retires the old orphan paper identity while canonical enrollment preserves its positive replacement", async () => {
    const [orphan] = await db.insert(polyTraderWallets).values({ walletAddress: ORPHAN_PAPER_WALLET,
      kind: "paper_wallet", label: "Old orphan hydration fixture" }).returning({ id: polyTraderWallets.id });
    if (!orphan) throw new Error("orphan hydration identity absent");
    try {
      await db.insert(polyTraderCurrentPositions).values({ traderWalletId: orphan.id, conditionId: PAPER_CONDITION,
        tokenId: PAPER_TOKEN, shares: "10", costBasisUsdc: "5", currentValueUsdc: "6", avgPrice: ".5",
        contentHash: randomUUID(), active: true, lastObservedAt: new Date() });
      // Keep the deterministic reproduction atomic with respect to other workers.
      await db.transaction(async tx => {
        await tx.update(polyTraderWallets).set({ activeForResearch: true, disabledAt: null }).where(eq(polyTraderWallets.id, orphan.id));
        const before = await readFullComparisonCoverageCounts({ db: tx, billingAccountId: BILLING_ID,
          walletAddress: ORPHAN_PAPER_WALLET, connectionKind: "paper" });
        expect(before.find(row => row.entity === "positions" && row.status === "live")).toMatchObject({ eligible: 1, comparable: 1 });
        const accounts = await readActivePaperAccounts(tx as never, noopLogger);
        expect(accounts.some(account => account.address === PAPER_LOCAL_WALLET)).toBe(true);
        expect(accounts.some(account => account.address === ORPHAN_PAPER_WALLET)).toBe(false);
        await syncPaperTraderWallets(tx as never, accounts);
        const [state] = await tx.select({ active: polyTraderWallets.activeForResearch, disabledAt: polyTraderWallets.disabledAt })
          .from(polyTraderWallets).where(eq(polyTraderWallets.id, orphan.id));
        expect(state).toMatchObject({ active: false, disabledAt: expect.any(Date) });
        const retired = await readFullComparisonCoverageCounts({ db: tx, billingAccountId: BILLING_ID,
          walletAddress: ORPHAN_PAPER_WALLET, connectionKind: "paper" });
        expect(retired.find(row => row.entity === "positions" && row.status === "live")).toMatchObject({ eligible: 0, comparable: 0 });
        const retained = await readFullComparisonCoverageCounts({ db: tx, billingAccountId: BILLING_ID,
          walletAddress: PAPER_LOCAL_WALLET, connectionKind: "paper" });
        expect(retained.find(row => row.entity === "positions" && row.status === "live")).toMatchObject({ eligible: 1, comparable: 1 });
      });
    } finally { await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, orphan.id)); }
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
			.where(and(eq(polyWalletConnections.billingAccountId, BILLING_ID), eq(polyWalletConnections.kind, "privy_live")));
		try {
			expect(await readCopyTargetPositionCohorts(db)).toEqual([{ targetWallet: TARGET_WALLET, conditions: [PAPER_CONDITION],
        exactLocalKeys: [{ conditionId: PAPER_CONDITION, tokenId: PAPER_TOKEN }] }]);
		} finally {
			await db
				.update(polyWalletConnections)
				.set({ funderAddress: OUR_WALLET })
				.where(and(eq(polyWalletConnections.billingAccountId, BILLING_ID), eq(polyWalletConnections.kind, "privy_live")));
		}
	});

	it("requires exact condition+token and publishes only complete scoped cohorts", async () => {
		const cohorts = await readCopyTargetPositionCohorts(db);
		expect(cohorts).toEqual([
			{
				targetWallet: TARGET_WALLET,
				conditions: [CONDITION, ZERO_VALUE_CONDITION, PAPER_CONDITION],
				exactLocalKeys: [
					{ conditionId: CONDITION, tokenId: LOCAL_TOKEN },
					{ conditionId: ZERO_VALUE_CONDITION, tokenId: ZERO_VALUE_TOKEN },
          { conditionId: PAPER_CONDITION, tokenId: PAPER_TOKEN },
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
    const paperEligibilityState = () => db.execute(sql`
      SELECT w.kind, w.active_for_research, w.disabled_at, w.updated_at,
        p.active, p.shares, p.cost_basis_usdc, p.current_value_usdc, p.last_observed_at,
        p.raw->>'redeemable' AS redeemable, p.raw->>'endDate' AS end_date,
        o.outcome, o.payout, o.resolved_at
      FROM poly_trader_wallets w
      LEFT JOIN poly_trader_current_positions p ON p.trader_wallet_id=w.id
        AND p.condition_id=${PAPER_CONDITION} AND p.token_id=${PAPER_TOKEN}
      LEFT JOIN poly_market_outcomes o ON o.condition_id=p.condition_id AND o.token_id=p.token_id
      WHERE w.id=${paperTraderWalletId}`);
    const paperEligibilityBefore = await paperEligibilityState();
    expect(paperEligibilityBefore).toMatchObject([{ kind: "paper_wallet", active_for_research: true,
      disabled_at: null, active: true, shares: "10.00000000", current_value_usdc: "6.00000000" }]);
    // Enrollment may legitimately refresh its bookkeeping clock while preserving
    // all eligibility/current-position facts. Keep that clock in the captured
    // evidence, but compare the predicate inputs independently of it.
    const eligibilityFacts = (rows: Awaited<ReturnType<typeof paperEligibilityState>>) =>
      rows.map(({ updated_at: _updatedAt, ...eligibility }) => eligibility);

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
        position(PAPER_TOKEN, PAPER_CONDITION),
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
    expect(eligibilityFacts(await paperEligibilityState())).toEqual(eligibilityFacts(paperEligibilityBefore));
		expect(first).toEqual({ cohorts: 1, conditions: 3, rows: 4, errors: 0 });
		expect(listUserPositionsV2).toHaveBeenLastCalledWith(TARGET_WALLET, {
			conditions: [CONDITION, ZERO_VALUE_CONDITION, PAPER_CONDITION],
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

    expect(eligibilityFacts(await paperEligibilityState())).toEqual(eligibilityFacts(paperEligibilityBefore));
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
    expect(eligibilityFacts(await paperEligibilityState())).toEqual(eligibilityFacts(paperEligibilityBefore));
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
			conditions: 3,
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
			const inactiveObservedAt = new Date("2026-10-09T09:58:00.000Z");
			await db.insert(polyTraderCurrentPositions).values([
				{
					traderWalletId: wallet.id,
					conditionId: POSITION_GAP_FUTURE_CONDITION,
					tokenId: POSITION_GAP_FUTURE_TOKEN,
					shares: "1.00000000",
					costBasisUsdc: "0.50000000",
					currentValueUsdc: "0.60000000",
					avgPrice: "0.50000000",
					contentHash: `future-${suffix}`,
					lastObservedAt: new Date("2026-10-09T10:02:00.000Z"),
				},
				{
					traderWalletId: wallet.id,
					conditionId: POSITION_GAP_FUTURE_CONDITION,
					tokenId: `${POSITION_GAP_FUTURE_TOKEN}-inactive`,
					active: false,
					shares: "0.00000000",
					costBasisUsdc: "0.00000000",
					currentValueUsdc: "0.00000000",
					avgPrice: "0.00000000",
					contentHash: `inactive-${suffix}`,
					lastObservedAt: inactiveObservedAt,
				},
			]);
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
					lastObservedAt: polyTraderCurrentPositions.lastObservedAt,
				})
				.from(polyTraderCurrentPositions)
				.where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
			expect(finalCurrent).toEqual(
				expect.arrayContaining([
					{
						tokenId: POSITION_GAP_TOKEN_A,
						shares: "125.00000000",
						active: true,
						lastObservedAt: new Date(latest.updatedAtMs),
					},
					{
						tokenId: POSITION_GAP_TOKEN_B,
						shares: "20.00000000",
						active: false,
						lastObservedAt: new Date(latest.updatedAtMs),
					},
					{
						tokenId: POSITION_GAP_FUTURE_TOKEN,
						shares: "1.00000000",
						active: true,
						lastObservedAt: new Date("2026-10-09T10:02:00.000Z"),
					},
					{
						tokenId: `${POSITION_GAP_FUTURE_TOKEN}-inactive`,
						shares: "0.00000000",
						active: false,
						lastObservedAt: inactiveObservedAt,
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


describe("authenticated paper-only REAL target hydration", () => {
  it("retains disabled exact opposite and third legs, rejects zero/unbound/wrong-target origins, and preserves saved facts on provider failure", async () => {
    const db = getSeedDb();
    const owner = randomUUID(), account = randomUUID(), connection = randomUUID();
    const targetWallet = `0x${randomUUID().replaceAll("-", "")}12345678` as `0x${string}`;
    const targetId = targetIdFromWallet(targetWallet);
    const address = derivePaperAccountAddress(account);
    const condition = `0x${randomUUID().replaceAll("-", "").repeat(2)}`;
    const thirdCondition = `0x${randomUUID().replaceAll("-", "").repeat(2)}`;
    const zeroCondition = `0x${randomUUID().replaceAll("-", "").repeat(2)}`;
    const legs = [{ conditionId: condition, tokenId: "987001" }, { conditionId: condition, tokenId: "987002" },
      { conditionId: thirdCondition, tokenId: "987003" }];
    await db.insert(users).values({ id: owner, walletAddress: targetWallet });
    await db.insert(billingAccounts).values({ id: account, ownerUserId: owner, balanceCredits: 0n });
    await db.insert(polyWalletConnections).values({ id: connection, billingAccountId: account,
      createdByUserId: owner, kind: "paper", address, funderAddress: address, paperSeedUsdc: "100",
      custodialConsentAcceptedAt: new Date(), custodialConsentActorKind: "user", custodialConsentActorId: owner });
    await db.insert(polyWalletGrants).values({ billingAccountId: account, walletConnectionId: connection,
      createdByUserId: owner, scopes: ["poly:trade:buy"], perOrderUsdcCap: "10", dailyUsdcCap: "1000", hourlyFillsCap: 1000 });
    await db.insert(polyCopyTradeTargets).values({ billingAccountId: account, createdByUserId: owner,
      targetWallet, disabledAt: new Date() });
    const [localWallet] = await db.insert(polyTraderWallets).values({ walletAddress: address,
      kind: "paper_wallet", label: "Authenticated paper hydration" }).returning({ id: polyTraderWallets.id });
    if (!localWallet) throw new Error("paper hydration local wallet absent");
    let native: OrderReceipt;
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://paper.hydration.test");
      expect(url.searchParams.get("account_id")).toBe(connection);
      expect(url.pathname).toBe(`/orders/${native.order_id}`);
      return Response.json(native);
    });
    try {
      const factory = createPolyTradeExecutorFactory({ logger: noopLogger as never, metrics: noopMetrics,
        paperSidecarUrl: "http://paper.hydration.test", paperVenue: createPaperVenue({ db }),
        resolveExecutionVenue: createExecutionVenueResolver({ db }) });
      const executor = await factory.getPolyTradeExecutorFor(account);
      const ledger = createOrderLedger({ db, logger: noopLogger as never, resolveExecutionMode: async () => "paper" });
      for (const [index, leg] of [...legs, { conditionId: zeroCondition, tokenId: "987004" },
        { conditionId: zeroCondition, tokenId: "987005" }, { conditionId: zeroCondition, tokenId: "987006" },
        { conditionId: zeroCondition, tokenId: "987007" }, { conditionId: zeroCondition, tokenId: "987008" },
        { conditionId: zeroCondition, tokenId: "987009" }].entries()) {
        const client = randomUUID(), order = randomUUID();
        const intent = { provider: "polymarket" as const, market_id: `prediction-market:polymarket:${leg.conditionId}`,
          outcome: "0", side: "BUY" as const, size_usdc: 1.5, limit_price: 0.5, client_order_id: client,
          attributes: { condition_id: leg.conditionId, token_id: leg.tokenId, placement: "limit", target_wallet: targetWallet, position_gap_version: "3" } };
        await ledger.insertPending({ billing_account_id: account, created_by_user_id: owner,
          target_id: index === 5 ? randomUUID() : targetId, fill_id: client, observed_at: new Date(), intent });
        native = { order_id: order, client_order_id: client, status: index === 3 ? "canceled" : "filled",
          filled_size_usdc: index === 3 ? 0 : 1.5, ...(index === 3 ? {} : { total_shares: 3, fill_price: 0.5 }),
          fees_usdc: 0, submitted_at: new Date().toISOString(),
          attributes: { market: leg.conditionId, tokenId: leg.tokenId, side: "BUY", sizeMatched: index === 3 ? 0 : 3 } };
        if (index !== 4) {
          const receipt = await executor.getOrder(order);
          if (!("found" in receipt)) throw new Error("hydration native receipt absent");
          const accepted = await ledger.markOrderId({ client_order_id: client, receipt: receipt.found });
          if (!accepted) throw new Error("hydration accepted ledger observation absent");
          expect(accepted.accepted).toBe(true);
        } else {
          // Source-only historical rows never create positive authority.
          await db.update(polyCopyTradeFills).set({ orderId: order, status: "filled", shares: "3", price: ".5",
            attributes: sql`${polyCopyTradeFills.attributes} || '{"filled_size_usdc":1.5,"realized_fill_source":"paper_order_receipt"}'::jsonb` })
            .where(eq(polyCopyTradeFills.clientOrderId, client));
        }
        if (index === 8) await db.update(polyCopyTradeFills).set({
          attributes: sql`jsonb_set(${polyCopyTradeFills.attributes}, '{paper_receipt_v1,billing_account_id}', '"wrong-tenant"'::jsonb)` })
          .where(eq(polyCopyTradeFills.clientOrderId, client));
        await db.insert(polyTraderCurrentPositions).values({ traderWalletId: localWallet.id,
          conditionId: leg.conditionId, tokenId: index === 7 ? "987099" : leg.tokenId, shares: "3", costBasisUsdc: "1.5",
          currentValueUsdc: "1.8", avgPrice: ".5", contentHash: randomUUID(), lastObservedAt: new Date(), active: index !== 6 });
      }
      const own = (await readCopyTargetPositionCohorts(db)).find(cohort => cohort.targetWallet === targetWallet);
      expect(own).toEqual({ targetWallet, conditions: [condition, thirdCondition].sort(),
        exactLocalKeys: [...legs].sort((x, y) => x.conditionId.localeCompare(y.conditionId) || x.tokenId.localeCompare(y.tokenId)) });
      // Revocation blocks new admission while preserving executions accepted
      // before revocation. An existing cached factory cannot bypass the lock.
      const revokedAt = new Date();
      await db.update(polyWalletConnections).set({ revokedAt }).where(eq(polyWalletConnections.id, connection));
      const rejectedClient = randomUUID(), rejectedOrder = randomUUID();
      await ledger.insertPending({ billing_account_id: account, created_by_user_id: owner, target_id: targetId,
        fill_id: rejectedClient, observed_at: new Date(), intent: { provider: "polymarket", market_id: `prediction-market:polymarket:${zeroCondition}`,
          outcome: "0", side: "BUY", size_usdc: 1.5, limit_price: .5, client_order_id: rejectedClient,
          attributes: { condition_id: zeroCondition, token_id: "987010", side: "BUY", target_wallet: targetWallet } } });
      native = { order_id: rejectedOrder, client_order_id: rejectedClient, status: "filled", filled_size_usdc: 1.5,
        total_shares: 3, fill_price: .5, fees_usdc: 0, submitted_at: new Date().toISOString(),
        attributes: { market: zeroCondition, tokenId: "987010", side: "BUY", sizeMatched: 3 } };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(revokedAt.getTime() + 1));
      try {
        const rejected = await executor.getOrder(rejectedOrder);
        if (!("found" in rejected)) throw new Error("revoked connection native absent");
        const rejection = await ledger.markOrderId({ client_order_id: rejectedClient, receipt: rejected.found });
        if (!rejection) throw new Error("revoked connection result absent");
        expect(rejection.accepted).toBe(false);
      } finally { vi.useRealTimers(); }
      expect((await readCopyTargetPositionCohorts(db)).find(cohort => cohort.targetWallet === targetWallet)).toEqual(own);
      // The same exact key has independent LIVE and PAPER origins in one tenant.
      const liveAddress = `0x${randomUUID().replaceAll("-", "")}abcdef12`;
      const liveConnection = randomUUID();
      await db.insert(polyWalletConnections).values({ id: liveConnection, billingAccountId: account,
        createdByUserId: owner, kind: "privy_live", address: liveAddress, funderAddress: liveAddress,
        privyWalletId: `privy-${liveConnection}`, clobApiKeyCiphertext: Buffer.from("component-test"), encryptionKeyId: "component-test",
        custodialConsentAcceptedAt: new Date(), custodialConsentActorKind: "user", custodialConsentActorId: owner });
      await db.insert(polyWalletGrants).values({ billingAccountId: account, walletConnectionId: liveConnection,
        createdByUserId: owner, scopes: ["poly:trade:buy"], perOrderUsdcCap: "10", dailyUsdcCap: "1000", hourlyFillsCap: 1000 });
      const [liveWallet] = await db.insert(polyTraderWallets).values({ walletAddress: liveAddress, kind: "cogni_wallet", label: "Mixed hydration live wallet" }).returning({ id: polyTraderWallets.id });
      if (!liveWallet) throw new Error("mixed hydration live wallet absent");
      await db.insert(polyTraderCurrentPositions).values({ traderWalletId: liveWallet.id, conditionId: condition,
        tokenId: "987001", shares: "3", costBasisUsdc: "1.5", currentValueUsdc: "1.8", avgPrice: ".5",
        contentHash: randomUUID(), lastObservedAt: new Date(), active: true });
      await db.insert(polyCopyTradeFills).values({ billingAccountId: account, createdByUserId: owner, targetId,
        fillId: randomUUID(), clientOrderId: randomUUID(), orderId: randomUUID(), mode: "live", status: "filled",
        observedAt: new Date(), marketId: `prediction-market:polymarket:${condition}`, shares: "3", price: ".5",
        attributes: { target_wallet: targetWallet, condition_id: condition, token_id: "987001", side: "BUY",
          position_gap_version: "3", realized_fill_source: "clob_associated_trades", filled_size_usdc: 1.5 } });
      expect((await readCopyTargetPositionCohorts(db)).find(cohort => cohort.targetWallet === targetWallet)).toEqual(own);
      const observed = legs.map((leg, index) => ({ ...position(leg.tokenId, leg.conditionId), proxyWallet: targetWallet,
        outcome: index === 1 ? "NO" : "YES", oppositeAsset: index === 0 ? legs[1]?.tokenId ?? "" : legs[0]?.tokenId ?? "" }));
      let failSecondPage = false;
      const targetFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("http://real-target.hydration.test");
        expect(url.pathname).toBe("/v2/positions");
        expect(url.searchParams.get("user")).toBe(targetWallet);
        expect(url.searchParams.get("condition")).toBe([condition, thirdCondition].sort().join(","));
        expect(url.searchParams.get("status")).toBe("OPEN");
        const second = url.searchParams.get("cursor") === "second-page";
        if (second && failSecondPage) return new Response("controlled incomplete walk", { status: 503 });
        const data = (second ? observed.slice(2) : observed.slice(0, 2)).map(row => ({
          condition_id: row.conditionId, token_id: row.asset, proxy_wallet: targetWallet, status: "OPEN",
          current_size: row.size, avg_price: row.avgPrice, current_price: row.curPrice, current_value: row.currentValue,
          entry_cost_usdc: row.initialValue, entry_fees_usdc: 0, total_cost_usdc: row.initialValue,
          total_pnl: row.cashPnl, total_size: row.totalBought, realized_pnl: row.realizedPnl,
          percent_pnl: row.percentPnl, percent_realized_pnl: row.percentRealizedPnl, unrealized_pnl: row.cashPnl,
          title: row.title, outcome: row.outcome, opposite_token_id: row.oppositeAsset, end_date: row.endDate,
        }));
        return Response.json({ data, pagination: { has_more: !second, limit: 1000,
          offset: second ? 2 : 0, next_cursor: second ? null : "second-page" } });
      });
      const targetClient = new PolymarketDataApiClient({ baseUrl: "http://real-target.hydration.test", fetch: targetFetch });
      const hydrated = await hydrateCopyTargetPositions({ db, client: targetClient, logger: noopLogger });
      expect(hydrated.errors).toBe(0);
      expect(targetFetch).toHaveBeenCalledTimes(2);
      const saved = await db.select({ condition: polyTraderCurrentPositions.conditionId,
        token: polyTraderCurrentPositions.tokenId, shares: polyTraderCurrentPositions.shares })
        .from(polyTraderCurrentPositions).innerJoin(polyTraderWallets, eq(polyTraderWallets.id, polyTraderCurrentPositions.traderWalletId))
        .where(eq(polyTraderWallets.walletAddress, targetWallet));
      expect(saved).toHaveLength(3);
      const publication = () => db.execute(sql`SELECT
        (SELECT count(*) FROM poly_trader_position_snapshots s JOIN poly_trader_wallets w ON w.id=s.trader_wallet_id WHERE w.wallet_address=${targetWallet})::int AS snapshots,
        (SELECT jsonb_build_object('status',c.status,'seen',c.last_seen_at,'success',c.last_success_at)
          FROM poly_trader_ingestion_cursors c JOIN poly_trader_wallets w ON w.id=c.trader_wallet_id
          WHERE w.wallet_address=${targetWallet} AND c.source=${COPY_TARGET_POSITION_CURSOR_SOURCE}) AS cursor`);
      const completePublication = await publication();
      expect(completePublication[0]).toMatchObject({ snapshots: 3, cursor: { status: "ok" } });
      failSecondPage = true;
      const failed = await hydrateCopyTargetPositions({ db, client: targetClient, logger: noopLogger });
      expect(failed.errors).toBe(1);
      const retained = await db.select({ condition: polyTraderCurrentPositions.conditionId,
        token: polyTraderCurrentPositions.tokenId, shares: polyTraderCurrentPositions.shares })
        .from(polyTraderCurrentPositions).innerJoin(polyTraderWallets, eq(polyTraderWallets.id, polyTraderCurrentPositions.traderWalletId))
        .where(eq(polyTraderWallets.walletAddress, targetWallet));
      expect(retained).toEqual(saved);
      expect(await publication()).toEqual(completePublication);
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.id, liveWallet.id));
    } finally {
      transport.mockRestore();
      await db.delete(polyCopyTradeFills).where(eq(polyCopyTradeFills.billingAccountId, account));
      await db.delete(polyCopyTradeTargets).where(eq(polyCopyTradeTargets.billingAccountId, account));
      await db.delete(polyWalletGrants).where(eq(polyWalletGrants.billingAccountId, account));
      await db.execute(sql`DELETE FROM poly_trader_wallets WHERE wallet_address IN (SELECT address FROM poly_wallet_connections WHERE billing_account_id=${account})`);
      await db.delete(polyWalletConnections).where(eq(polyWalletConnections.billingAccountId, account));
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.walletAddress, address));
      await db.delete(polyTraderWallets).where(eq(polyTraderWallets.walletAddress, targetWallet));
      await db.delete(billingAccounts).where(eq(billingAccounts.id, account));
      await db.delete(users).where(eq(users.id, owner));
    }
  });
});
