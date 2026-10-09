// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { randomUUID } from "node:crypto";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import {
	polyPositionGapActions,
	polyPositionGapCohorts,
	polyPositionGapReservations,
	polyPositionGapRuns,
} from "@cogni/db-schema/position-gap";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { buildPositionGapBuyIntent } from "@/features/copy-trade/position-gap-actor";
import { projectPositionGapCohorts } from "@/features/copy-trade/position-gap-cohorts";
import {
	PositionGapReservationConflictError,
	PositionGapRuntimeStore,
} from "@/features/copy-trade/position-gap-runtime-store";
import { createOrderLedger } from "@/features/trading/order-ledger";
import { billingAccounts, users } from "@/shared/db/schema";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const future = new Date("2099-01-01T00:00:00.000Z");
const asOf = new Date("2026-10-08T00:00:00.000Z");

describe("position-gap runtime persistence", () => {
	let appDb: Database;
	const ownerA = randomUUID();
	const ownerB = randomUUID();
	const delegate = randomUUID();
	const stranger = randomUUID();
	const accountA = randomUUID();
	const accountB = randomUUID();
	const targetA = randomUUID();
	const targetB = randomUUID();
	const targetSafety = randomUUID();
	const targetNotFound = randomUUID();
	const targetQuantized = randomUUID();
	const targetActivationBackfill = randomUUID();
	const targetAmbiguousRejection = randomUUID();
	const targetAccountExposureA = randomUUID();
	const targetAccountExposureB = randomUUID();
	const targetReservationCatchup = randomUUID();
	const targetCanceledReceipt = randomUUID();

	beforeAll(async () => {
		appDb = getAppDb();
		const db = getSeedDb();
		await db.insert(users).values(
			[ownerA, ownerB, delegate, stranger].map((id, index) => ({
				id,
				name: `Position gap principal ${index}`,
				walletAddress: `0x${id.replaceAll("-", "")}${"0".repeat(8)}`.slice(
					0,
					42,
				),
			})),
		);
		await db.insert(billingAccounts).values([
			{ id: accountA, ownerUserId: ownerA, balanceCredits: 0n },
			{ id: accountB, ownerUserId: ownerB, balanceCredits: 0n },
		]);
		await db.insert(agentCapabilityGrants).values({
			billingAccountId: accountA,
			granteePrincipalId: delegate,
			scopes: ["account:read"],
			expiresAt: future,
			createdByUserId: ownerA,
		});

		const runB = randomUUID();
		const cohortB = randomUUID();
		const actionB = randomUUID();
		await db.insert(polyPositionGapRuns).values({
			id: runB,
			billingAccountId: accountB,
			createdByUserId: ownerB,
			targetId: targetB,
			budgetUsdc: "10",
			walletCashUsdcAtStart: "10",
			status: "completed",
			completedAt: asOf,
		});
		await db.insert(polyPositionGapCohorts).values({
			id: cohortB,
			billingAccountId: accountB,
			createdByUserId: ownerB,
			targetId: targetB,
			cohortKey: "tenant-b-cohort",
			sourceKind: "activation",
			sourceConfigRevision: "rev-b",
			sourceSnapshotId: "snapshot-b",
			sourceSnapshotHash: "hash-b",
			sourceSnapshotAsOf: asOf,
			sourceProvenance: { marker: "tenant-b" },
			createdRunId: runB,
			conditionId: "condition-b",
			tokenId: "token-b",
			marketId: "prediction-market:polymarket:condition-b",
			outcome: "0",
			targetDeltaShares: "10",
			scaleAtCreation: "1",
			allowedMirrorShares: "10",
			initialAllowedMirrorShares: "10",
			benchmarkTargetVwap: "0.5",
			remainingShares: "10",
		});
		await db.insert(polyPositionGapActions).values({
			id: actionB,
			billingAccountId: accountB,
			createdByUserId: ownerB,
			targetId: targetB,
			runId: runB,
			cohortId: cohortB,
			cohortKey: "tenant-b-cohort",
			actionKey: "tenant-b-action",
			kind: "buy",
			conditionId: "condition-b",
			tokenId: "token-b",
			marketId: "prediction-market:polymarket:condition-b",
			outcome: "0",
			desiredShares: "2",
			notionalUsdc: "1",
			limitPrice: "0.5",
			plannerAction: { marker: "tenant-b" },
			clientOrderId: `pg-b-${randomUUID()}`,
			status: "open",
		});
		await db.insert(polyPositionGapReservations).values({
			billingAccountId: accountB,
			createdByUserId: ownerB,
			targetId: targetB,
			cohortId: cohortB,
			buyActionId: actionB,
			budgetNotionalUsdc: "1",
			executorCashGuardAtomic: "1100000",
			cashGuardSource: "test",
		});
	});

	it("loads complete active BUY exposure across every target in the account", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const firstClientOrderId = `account-exposure-a-${randomUUID()}`;
		const secondClientOrderId = `account-exposure-b-${randomUUID()}`;
		const otherAccountClientOrderId = `account-exposure-other-${randomUUID()}`;
		await db.insert(polyCopyTradeFills).values([
			{
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetAccountExposureA,
				fillId: `test:${randomUUID()}`,
				marketId: "prediction-market:polymarket:account-exposure-a",
				observedAt: asOf,
				clientOrderId: firstClientOrderId,
				orderId: `venue-${randomUUID()}`,
				status: "partial",
				shares: "4",
				attributes: {
					side: "BUY",
					condition_id: "account-exposure-a",
					token_id: "token-a",
					size_usdc: 10,
					limit_price: 0.5,
				},
			},
			{
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetAccountExposureB,
				fillId: `test:${randomUUID()}`,
				marketId: "prediction-market:polymarket:account-exposure-b",
				observedAt: asOf,
				clientOrderId: secondClientOrderId,
				status: "pending",
				attributes: {
					side: "BUY",
					condition_id: "account-exposure-b",
					token_id: "token-b",
					size_usdc: 3,
					limit_price: 0.25,
				},
			},
			{
				billingAccountId: accountB,
				createdByUserId: ownerB,
				targetId: targetAccountExposureA,
				fillId: `test:${randomUUID()}`,
				marketId: "prediction-market:polymarket:account-exposure-other",
				observedAt: asOf,
				clientOrderId: otherAccountClientOrderId,
				status: "open",
				attributes: {
					side: "BUY",
					condition_id: "account-exposure-other",
					token_id: "token-other",
					size_usdc: 100,
					limit_price: 0.5,
				},
			},
		]);

		try {
			const exposure = await store.loadAccountBuyExposure({
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetAccountExposureA,
			});
			expect(
				exposure
					.filter((row) =>
						[firstClientOrderId, secondClientOrderId].includes(
							row.clientOrderId,
						),
					)
					.map((row) => ({
						clientOrderId: row.clientOrderId,
						remainingShares: row.remainingShares,
					}))
					.sort((left, right) =>
						left.clientOrderId.localeCompare(right.clientOrderId),
					),
			).toEqual([
				{ clientOrderId: firstClientOrderId, remainingShares: 16 },
				{ clientOrderId: secondClientOrderId, remainingShares: 12 },
			]);
			expect(
				exposure.some((row) => row.clientOrderId === otherAccountClientOrderId),
			).toBe(false);
		} finally {
			await db
				.delete(polyCopyTradeFills)
				.where(
					inArray(polyCopyTradeFills.clientOrderId, [
						firstClientOrderId,
						secondClientOrderId,
						otherAccountClientOrderId,
					]),
				);
		}
	});

	it("fails closed when active BUY exposure lacks sizing provenance", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const clientOrderId = `account-exposure-malformed-${randomUUID()}`;
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetAccountExposureA,
			fillId: `test:${randomUUID()}`,
			marketId: "prediction-market:polymarket:account-exposure-malformed",
			observedAt: asOf,
			clientOrderId,
			status: "open",
			attributes: {
				side: "BUY",
				condition_id: "account-exposure-malformed",
				token_id: "token-malformed",
				limit_price: 0.5,
			},
		});

		try {
			await expect(
				store.loadAccountBuyExposure({
					billingAccountId: accountA,
					createdByUserId: ownerA,
					targetId: targetAccountExposureA,
				}),
			).rejects.toThrow(
				`active BUY exposure was malformed for ${clientOrderId}`,
			);
		} finally {
			await db
				.delete(polyCopyTradeFills)
				.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));
		}
	});

	afterAll(async () => {
		const db = getSeedDb();
		await db
			.delete(polyCopyTradeFills)
			.where(
				inArray(polyCopyTradeFills.billingAccountId, [accountA, accountB]),
			);
		await db
			.delete(polyPositionGapReservations)
			.where(
				inArray(polyPositionGapReservations.billingAccountId, [
					accountA,
					accountB,
				]),
			);
		await db
			.delete(polyPositionGapActions)
			.where(
				inArray(polyPositionGapActions.billingAccountId, [accountA, accountB]),
			);
		await db
			.delete(polyPositionGapCohorts)
			.where(
				inArray(polyPositionGapCohorts.billingAccountId, [accountA, accountB]),
			);
		await db
			.delete(polyPositionGapRuns)
			.where(
				inArray(polyPositionGapRuns.billingAccountId, [accountA, accountB]),
			);
		await db
			.delete(agentCapabilityGrants)
			.where(eq(agentCapabilityGrants.billingAccountId, accountA));
		await db
			.delete(billingAccounts)
			.where(inArray(billingAccounts.id, [accountA, accountB]));
		await db
			.delete(users)
			.where(inArray(users.id, [ownerA, ownerB, delegate, stranger]));
	});

	it("serializes aggregate reservations and makes exact replay idempotent", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const scope = {
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetA,
		};
		const cohortKey = "tenant-a-cohort";
		const base = {
			scope,
			triggerReasons: ["activation"],
			snapshot: {
				id: "snapshot-a",
				hash: "hash-a",
				asOf,
				expiresAt: new Date(asOf.getTime() + 600_000),
				value: { version: 1, complete: true },
			},
			plannerVersion: "test",
			budgetUsdc: 10,
			eligibleNetNavUsdc: 100,
			scale: 0.1,
			walletCashUsdc: 20,
			plan: { version: 1, status: "ready" },
			cohortCreations: [
				{
					cohortKey,
					sourceKind: "activation" as const,
					sourceEventId: null,
					sourceConfigRevision: "rev-a",
					conditionId: "condition-a",
					tokenId: "token-a",
					marketId: "prediction-market:polymarket:condition-a",
					outcome: "0",
					targetDeltaShares: 20,
					scaleAtCreation: 1,
					allowedMirrorShares: 20,
					benchmarkTargetVwap: 0.5,
					remainingShares: 20,
					createdAtMs: asOf.getTime(),
					provenance: { created_at_ms: asOf.getTime() },
				},
			],
			cohortReductions: [],
			cancellations: [],
		};
		const buy = (suffix: string) => ({
			actionKey: `action-${suffix}`,
			cohortKey,
			conditionId: "condition-a",
			tokenId: "token-a",
			marketId: "prediction-market:polymarket:condition-a",
			outcome: "0",
			shares: 12,
			notionalUsdc: 6,
			limitPrice: 0.5,
			clientOrderId: `client-${suffix}`,
			plannerAction: { suffix },
		});

		const settled = await Promise.allSettled([
			store.persistPlan({ ...base, buys: [buy("a")] }),
			store.persistPlan({ ...base, buys: [buy("b")] }),
		]);
		expect(
			settled.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const rejected = settled.find((result) => result.status === "rejected");
		expect(rejected?.status).toBe("rejected");
		if (rejected?.status === "rejected") {
			expect(rejected.reason).toBeInstanceOf(
				PositionGapReservationConflictError,
			);
		}

		const [persisted] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.billingAccountId, accountA));
		expect(persisted).toBeDefined();
		const replay = await store.persistPlan({
			...base,
			buys: [buy(persisted?.actionKey.endsWith("a") ? "a" : "b")],
		});
		expect(replay.buys).toHaveLength(1);
		const reservations = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.billingAccountId, accountA));
		expect(reservations).toHaveLength(1);

		await store.markLedgered(persisted?.id ?? "missing");
		await store.markSubmitting(persisted?.id ?? "missing");
		const receipt = (
			status: "filled" | "open" | "partial",
			filledSizeUsdc: number,
			totalShares?: number,
			verified = false,
		) => ({
			order_id: "venue-order-a",
			client_order_id: persisted?.clientOrderId ?? "missing",
			status,
			filled_size_usdc: filledSizeUsdc,
			...(totalShares === undefined
				? {}
				: {
						total_shares: totalShares,
						fill_price: filledSizeUsdc / totalShares,
					}),
			submitted_at: asOf.toISOString(),
			...(verified
				? { attributes: { realizedFillSource: "clob_associated_trades" } }
				: {}),
		});
		await store.markPlacementReceipt(
			persisted?.id ?? "missing",
			receipt("open", 0),
		);
		await store.markPlacementReceipt(
			persisted?.id ?? "missing",
			receipt("partial", 1.5, 4),
		);
		await store.markPlacementReceipt(
			persisted?.id ?? "missing",
			receipt("partial", 1, 2),
		);
		await store.markPlacementReceipt(
			persisted?.id ?? "missing",
			receipt("filled", 4, 12),
		);
		await store.markPlacementReceipt(
			persisted?.id ?? "missing",
			receipt("partial", 2, 6),
		);
		// Associated-trade accounting may arrive after a terminal order receipt.
		// Equal cumulative shares upgrades the source and may correct the old
		// limit-derived cost downward; a later lower-share receipt cannot regress it.
		await store.markPlacementReceipt(
			persisted?.id ?? "missing",
			receipt("filled", 0.012, 12, true),
		);
		await store.markPlacementReceipt(
			persisted?.id ?? "missing",
			receipt("filled", 0.0005, 6, true),
		);

		const [filledAction] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, persisted?.id ?? "missing"));
		const [filledReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(
				eq(polyPositionGapReservations.buyActionId, persisted?.id ?? "missing"),
			);
		expect(filledAction?.status).toBe("filled");
		expect(Number(filledAction?.filledShares)).toBe(12);
		expect(Number(filledAction?.filledUsdc)).toBe(0.012);
		expect(filledAction?.plannerAction.realized_fill_source).toBe(
			"clob_associated_trades",
		);
		expect(Number(filledReservation?.releasedBudgetUsdc)).toBe(5.988);

		const repairPending = await store.loadPlannerState(scope);
		expect(repairPending.activeBuys.map((action) => action.id)).toContain(
			persisted?.id,
		);
		expect(repairPending.openBuyOrders).toHaveLength(0);
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetA,
			fillId: `position-gap-v3:${persisted?.actionKey}`,
			marketId: "prediction-market:polymarket:condition-a",
			observedAt: asOf,
			clientOrderId: persisted?.clientOrderId ?? "missing",
			orderId: "venue-order-a",
			status: "filled",
			price: "0.001",
			shares: "12",
			attributes: {
				filled_size_usdc: 0.012,
				realized_fill_source: "clob_associated_trades",
			},
		});
		const repairVerified = await store.loadPlannerState(scope);
		expect(repairVerified.activeBuys.map((action) => action.id)).not.toContain(
			persisted?.id,
		);
	});

	it("repairs target-wallet lineage only in the account's execution mode", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const targetWallet = "0x1111111111111111111111111111111111111111";
		const targetId = targetIdFromWallet(targetWallet);
		const paperFillId = `paper-lineage-${randomUUID()}`;
		const liveFillId = `live-lineage-${randomUUID()}`;

		await db.insert(polyCopyTradeFills).values([
			{
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId,
				fillId: paperFillId,
				marketId: "prediction-market:polymarket:paper-lineage",
				observedAt: asOf,
				clientOrderId: `paper-lineage-${randomUUID()}`,
				status: "filled",
				mode: "paper",
				attributes: { position_gap_version: "3" },
			},
			{
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId,
				fillId: liveFillId,
				marketId: "prediction-market:polymarket:live-lineage",
				observedAt: asOf,
				clientOrderId: `live-lineage-${randomUUID()}`,
				status: "filled",
				mode: "live",
				attributes: { position_gap_version: "3" },
			},
		]);

		await store.repairTargetWalletLineage(
			{
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId,
			},
			targetWallet,
			"paper",
		);

		const rows = await db
			.select({
				fillId: polyCopyTradeFills.fillId,
				attributes: polyCopyTradeFills.attributes,
			})
			.from(polyCopyTradeFills)
			.where(inArray(polyCopyTradeFills.fillId, [paperFillId, liveFillId]));
		const attributesByFill = new Map(
			rows.map((row) => [row.fillId, row.attributes]),
		);
		expect(attributesByFill.get(paperFillId)?.target_wallet).toBe(targetWallet);
		expect(attributesByFill.get(liveFillId)?.target_wallet).toBeUndefined();
	});

	it("releases all 49 terminal reservations while retaining their provisional exposure", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const scope = {
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetReservationCatchup,
		};
		const runId = randomUUID();
		const cohortId = randomUUID();
		const plannedNotional = 73.42378 / 49;
		await db.insert(polyPositionGapRuns).values({
			id: runId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetReservationCatchup,
			budgetUsdc: "50",
			walletCashUsdcAtStart: "50",
			status: "completed",
			completedAt: asOf,
		});
		await db.insert(polyPositionGapCohorts).values({
			id: cohortId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetReservationCatchup,
			cohortKey: "terminal-catchup-cohort",
			sourceKind: "activation",
			sourceConfigRevision: "rev-terminal-catchup",
			sourceSnapshotId: "snapshot-terminal-catchup",
			sourceSnapshotHash: "hash-terminal-catchup",
			sourceSnapshotAsOf: asOf,
			sourceProvenance: {},
			createdRunId: runId,
			conditionId: "condition-terminal-catchup",
			tokenId: "token-terminal-catchup",
			marketId: "prediction-market:polymarket:condition-terminal-catchup",
			outcome: "0",
			targetDeltaShares: "98",
			scaleAtCreation: "1",
			allowedMirrorShares: "98",
			initialAllowedMirrorShares: "98",
			benchmarkTargetVwap: "0.284",
			acquiredShares: "48",
			openOrderShares: "0",
			remainingShares: "49",
			status: "exhausted",
		});
		const actions = Array.from({ length: 49 }, (_, index) => ({
			id: randomUUID(),
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetReservationCatchup,
			runId,
			cohortId,
			cohortKey: "terminal-catchup-cohort",
			actionKey: `terminal-catchup-action-${index}`,
			kind: "buy" as const,
			conditionId: "condition-terminal-catchup",
			tokenId: "token-terminal-catchup",
			marketId: "prediction-market:polymarket:condition-terminal-catchup",
			outcome: "0",
			desiredShares: "2",
			filledShares: "1",
			filledUsdc: "0.1",
			notionalUsdc: plannedNotional.toString(),
			limitPrice: "0.284",
			plannerAction: { fill_accounting_status: "pending" },
			clientOrderId: `terminal-catchup-client-${index}`,
			orderId: `terminal-catchup-order-${index}`,
			status: "canceled" as const,
			completedAt: asOf,
		}));
		await db.insert(polyPositionGapActions).values(actions);
		await db.insert(polyPositionGapReservations).values(
			actions.map((action) => ({
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetReservationCatchup,
				cohortId,
				buyActionId: action.id,
				budgetNotionalUsdc: plannedNotional.toString(),
				executorCashGuardAtomic: "1648289",
				cashGuardSource: "test",
				filledCostUsdc: "0.1",
			})),
		);

		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBeCloseTo(
			73.42378,
			5,
		);
		const beforeRelease = await store.loadPlannerState(scope);
		expect(beforeRelease.openBuyOrders).toEqual([]);
		expect(beforeRelease.provisionalFilledHoldings).toEqual([
			{
				conditionId: "condition-terminal-catchup",
				tokenId: "token-terminal-catchup",
				shares: 49,
			},
		]);
		expect(await store.releaseCanceledOrderReservations(scope)).toBe(49);
		expect(await store.releaseCanceledOrderReservations(scope)).toBe(0);
		expect(await store.activeReservationTotals(scope)).toEqual({
			budgetUsdc: 0,
			cashGuardAtomicForAccount: 0n,
		});
		const reservations = await db
			.select()
			.from(polyPositionGapReservations)
			.where(
				eq(polyPositionGapReservations.targetId, targetReservationCatchup),
			);
		expect(reservations).toHaveLength(49);
		expect(
			reservations.every(
				(reservation) =>
					reservation.state === "released" &&
					Number(reservation.releasedBudgetUsdc) ===
						Number(reservation.budgetNotionalUsdc) &&
					reservation.releaseReason === "terminal_cancel_catchup",
			),
		).toBe(true);

		// A later historical cancel is released independently of durable cohort
		// attribution, while its uncertain fill remains in the exposure floor.
		const missingAcquisitionActionId = randomUUID();
		await db.insert(polyPositionGapActions).values({
			id: missingAcquisitionActionId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetReservationCatchup,
			runId,
			cohortId,
			cohortKey: "terminal-catchup-cohort",
			actionKey: "terminal-catchup-missing-acquisition",
			kind: "buy",
			conditionId: "condition-terminal-catchup",
			tokenId: "token-terminal-catchup",
			marketId: "prediction-market:polymarket:condition-terminal-catchup",
			outcome: "0",
			desiredShares: "2",
			filledShares: "1",
			filledUsdc: "0.1",
			notionalUsdc: "1.5",
			limitPrice: "0.284",
			plannerAction: { fill_accounting_status: "pending" },
			clientOrderId: "terminal-catchup-missing-acquisition-client",
			orderId: "terminal-catchup-missing-acquisition-order",
			status: "canceled",
			completedAt: asOf,
		});
		await db.insert(polyPositionGapReservations).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetReservationCatchup,
			cohortId,
			buyActionId: missingAcquisitionActionId,
			budgetNotionalUsdc: "1.5",
			executorCashGuardAtomic: "1650000",
			cashGuardSource: "test",
			filledCostUsdc: "0.1",
		});
		expect(await store.releaseCanceledOrderReservations(scope)).toBe(1);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBe(0);
		const afterRelease = await store.loadPlannerState(scope);
		expect(afterRelease.openBuyOrders).toEqual([]);
		expect(afterRelease.provisionalFilledHoldings).toEqual([
			{
				conditionId: "condition-terminal-catchup",
				tokenId: "token-terminal-catchup",
				shares: 50,
			},
		]);
	});

	it("atomically retains a terminal receipt's provisional shares while releasing its full order reservation", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const scope = {
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetCanceledReceipt,
		};
		const common = {
			scope,
			triggerReasons: ["activation"],
			snapshot: {
				id: "snapshot-canceled-receipt",
				hash: "hash-canceled-receipt",
				asOf,
				expiresAt: future,
				value: { version: 1, complete: true },
			},
			plannerVersion: "test",
			budgetUsdc: 50,
			eligibleNetNavUsdc: 50,
			scale: 1,
			walletCashUsdc: 50,
			plan: { version: 1, status: "ready" },
			cohortReductions: [],
		};
		const initial = await store.persistPlan({
			...common,
			cohortCreations: [
				{
					cohortKey: "canceled-receipt-cohort",
					sourceKind: "activation" as const,
					sourceEventId: null,
					sourceConfigRevision: "rev-canceled-receipt",
					conditionId: "condition-canceled-receipt",
					tokenId: "token-canceled-receipt",
					marketId: "prediction-market:polymarket:condition-canceled-receipt",
					outcome: "0",
					targetDeltaShares: 10,
					scaleAtCreation: 1,
					allowedMirrorShares: 10,
					benchmarkTargetVwap: 0.5,
					remainingShares: 10,
					createdAtMs: asOf.getTime(),
					provenance: { created_at_ms: asOf.getTime() },
				},
			],
			buys: [
				{
					actionKey: "canceled-receipt-buy",
					cohortKey: "canceled-receipt-cohort",
					conditionId: "condition-canceled-receipt",
					tokenId: "token-canceled-receipt",
					marketId: "prediction-market:polymarket:condition-canceled-receipt",
					outcome: "0",
					shares: 10,
					notionalUsdc: 5,
					limitPrice: 0.5,
					clientOrderId: "canceled-receipt-client",
					plannerAction: { side: "BUY" },
				},
			],
			cancellations: [],
		});
		const buy = initial.buys[0];
		if (!buy) throw new Error("canceled receipt buy missing");
		await store.markLedgered(buy.id);
		await store.markSubmitting(buy.id);
		await store.markPlacementReceipt(buy.id, {
			order_id: "canceled-receipt-order",
			client_order_id: "canceled-receipt-client",
			status: "partial",
			filled_size_usdc: 1,
			fill_price: 0.5,
			total_shares: 2,
			submitted_at: asOf.toISOString(),
		});
		const cancellation = await store.persistPlan({
			...common,
			triggerReasons: ["timer"],
			cohortCreations: [],
			buys: [],
			cancellations: [
				{
					actionKey: "canceled-receipt-cancel",
					cohortKey: "canceled-receipt-cohort",
					orderId: "canceled-receipt-order",
					reason: "runtime_safety" as const,
					plannerAction: { reason: "runtime_safety" },
				},
			],
		});
		const cancel = cancellation.cancellations[0];
		if (!cancel) throw new Error("canceled receipt cancellation missing");
		const terminalReceipt = {
			order_id: "canceled-receipt-order",
			client_order_id: "canceled-receipt-client",
			status: "canceled" as const,
			filled_size_usdc: 2,
			fill_price: 0.5,
			total_shares: 4,
			submitted_at: asOf.toISOString(),
		};
		await store.markPlacementReceipt(buy.id, terminalReceipt);
		await store.markCancelConfirmed(cancel.id);
		await store.markPlacementReceipt(buy.id, terminalReceipt);

		const [action] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, buy.id));
		const [cancelAction] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, cancel.id));
		const [reservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, buy.id));
		const [cohort] = await db
			.select()
			.from(polyPositionGapCohorts)
			.where(eq(polyPositionGapCohorts.cohortKey, "canceled-receipt-cohort"));
		expect(action?.status).toBe("canceled");
		expect(Number(action?.filledShares)).toBe(4);
		expect(cancelAction?.status).toBe("canceled");
		expect(reservation).toMatchObject({
			state: "released",
			releaseReason: "venue_cancel_confirmed",
		});
		expect(Number(reservation?.releasedBudgetUsdc)).toBe(5);
		expect(Number(cohort?.acquiredShares)).toBe(4);
		expect(Number(cohort?.remainingShares)).toBe(6);
		expect(Number(cohort?.openOrderShares)).toBe(0);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBe(0);
		const runtime = await store.loadPlannerState(scope);
		expect(runtime.cohorts[0]?.acquiredMirrorShares).toBe(4);
		expect(runtime.provisionalFilledHoldings).toEqual([
			{
				conditionId: "condition-canceled-receipt",
				tokenId: "token-canceled-receipt",
				shares: 4,
			},
		]);
		expect(runtime.activeBuys.map((entry) => entry.id)).toContain(buy.id);
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetCanceledReceipt,
			fillId: "position-gap-v3:canceled-receipt-buy",
			marketId: "prediction-market:polymarket:condition-canceled-receipt",
			observedAt: asOf,
			clientOrderId: "canceled-receipt-client",
			orderId: "canceled-receipt-order",
			status: "canceled",
			price: "0.45",
			shares: "4",
			attributes: { position_gap_version: "3" },
		});
		const evidence = {
			status: "verified" as const,
			source: "data_api_activity_position" as const,
			wallet: "0x8ca45685c5827f7acfdd890214180c4ea9d0bf58" as const,
			shares: 4,
			filledUsdc: 1.8,
			grossCashUsdc: 1.81,
			fillPrice: 0.45,
			feesUsdc: 0.01,
			transactionHashes: [`0x${"3".repeat(64)}`],
			evidenceStart: "2026-10-07T23:59:55.000Z",
			evidenceEnd: "2026-10-08T00:00:30.000Z",
		};
		expect(
			await store.applyDataApiFillAccounting(scope, buy.id, evidence),
		).toMatchObject({ to: "verified" });
		expect(
			await store.applyDataApiFillAccounting(scope, buy.id, evidence),
		).toMatchObject({ from: "verified", to: "verified" });
		const [verifiedReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, buy.id));
		expect(verifiedReservation?.state).toBe("released");
		expect(Number(verifiedReservation?.releasedBudgetUsdc)).toBe(5);
		expect(
			(await store.loadPlannerState(scope)).provisionalFilledHoldings,
		).toEqual([]);
	});

	it("backfills late activation once across timer replay, restart, and resolved tombstones", async () => {
		const db = getSeedDb();
		const scope = {
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetActivationBackfill,
		};
		const store = new PositionGapRuntimeStore(db);
		const firstPosition = {
			conditionId: "condition-activation-first",
			tokenId: "token-activation-first",
			marketId: "prediction-market:polymarket:condition-activation-first",
			outcome: "0",
			netShares: 100,
			activationPriceCap: 0.4,
		};
		const latePosition = {
			conditionId: "condition-activation-late",
			tokenId: "token-activation-late",
			marketId: "prediction-market:polymarket:condition-activation-late",
			outcome: "1",
			netShares: 50,
			activationPriceCap: 0.3,
		};
		const projection = (
			existing: Awaited<ReturnType<typeof store.loadCohorts>>,
			positions: readonly (typeof firstPosition)[],
			snapshot: number,
		) =>
			projectPositionGapCohorts({
				existing,
				netTargetPositions: positions,
				activity: [],
				snapshotId: `activation-snapshot-${snapshot}`,
				snapshotHash: `activation-hash-${snapshot}`,
				configRevision: "activation-revision",
				previousBudgetUsdc: null,
				budgetUsdc: 40,
				allocationDenominatorUsdc: 400,
				scale: 0.1,
				activation: true,
				nowMs: asOf.getTime() + snapshot * 1_000,
			});
		const persist = async (
			snapshot: number,
			cohortCreations: ReturnType<typeof projection>["creations"],
			buys: Parameters<typeof store.persistPlan>[0]["buys"] = [],
		) =>
			store.persistPlan({
				scope,
				triggerReasons: snapshot === 1 ? ["activation"] : ["timer"],
				snapshot: {
					id: `activation-snapshot-${snapshot}`,
					hash: `activation-hash-${snapshot}`,
					asOf: new Date(asOf.getTime() + snapshot * 1_000),
					expiresAt: future,
					value: { version: 1, complete: true },
				},
				plannerVersion: "position-gap-v3/book-plan-v1",
				budgetUsdc: 40,
				eligibleNetNavUsdc: 400,
				scale: 0.1,
				walletCashUsdc: 50,
				plan: { version: 1, status: "ready", intents: [] },
				cohortCreations,
				cohortReductions: [],
				buys,
				cancellations: [],
			});

		const initial = projection([], [firstPosition], 1);
		expect(initial.creations).toHaveLength(1);
		await persist(1, initial.creations);
		const [firstBefore] = await db
			.select()
			.from(polyPositionGapCohorts)
			.where(
				eq(
					polyPositionGapCohorts.cohortKey,
					initial.creations[0]?.cohortKey ?? "",
				),
			);

		const late = projection(
			await store.loadCohorts(scope),
			[firstPosition, latePosition],
			2,
		);
		expect(late.creations).toHaveLength(1);
		expect(late.creations[0]).toMatchObject({
			conditionId: latePosition.conditionId,
			tokenId: latePosition.tokenId,
			sourceKind: "activation",
			benchmarkTargetVwap: latePosition.activationPriceCap,
		});
		const lateCreation = late.creations[0];
		if (!lateCreation) throw new Error("late activation creation missing");
		const actionKey = "late-activation-buy";
		const clientOrderId = `pg-${randomUUID()}`;
		await persist(2, late.creations, [
			{
				actionKey,
				cohortKey: lateCreation.cohortKey,
				conditionId: lateCreation.conditionId,
				tokenId: lateCreation.tokenId,
				marketId: lateCreation.marketId,
				outcome: lateCreation.outcome,
				shares: lateCreation.allowedMirrorShares,
				notionalUsdc:
					lateCreation.allowedMirrorShares * lateCreation.benchmarkTargetVwap,
				limitPrice: lateCreation.benchmarkTargetVwap,
				clientOrderId,
				plannerAction: {
					side: "BUY",
					cohortId: lateCreation.cohortKey,
					targetVwap: lateCreation.benchmarkTargetVwap,
				},
			},
		]);

		const timerReplay = projection(
			await store.loadCohorts(scope),
			[firstPosition, latePosition],
			3,
		);
		expect(timerReplay.creations).toEqual([]);
		await persist(3, timerReplay.creations);

		const restartedStore = new PositionGapRuntimeStore(db);
		const restartReplay = projection(
			await restartedStore.loadCohorts(scope),
			[firstPosition, latePosition],
			4,
		);
		expect(restartReplay.creations).toEqual([]);

		await db
			.update(polyPositionGapCohorts)
			.set({ status: "resolved" })
			.where(eq(polyPositionGapCohorts.cohortKey, lateCreation.cohortKey));
		const resolvedReplay = projection(
			await new PositionGapRuntimeStore(db).loadCohorts(scope),
			[firstPosition, latePosition],
			5,
		);
		expect(resolvedReplay.creations).toEqual([]);

		const [firstAfter] = await db
			.select()
			.from(polyPositionGapCohorts)
			.where(eq(polyPositionGapCohorts.id, firstBefore?.id ?? "missing"));
		expect(firstAfter).toEqual(firstBefore);
		const actions = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.targetId, targetActivationBackfill));
		expect(actions).toHaveLength(1);
		expect(actions[0]?.kind).toBe("buy");
		expect(Number(actions[0]?.limitPrice)).toBeLessThanOrEqual(
			lateCreation.benchmarkTargetVwap,
		);
		const intent = buildPositionGapBuyIntent({
			marketId: actions[0]?.marketId ?? "missing",
			outcome: actions[0]?.outcome ?? "missing",
			notionalUsdc: Number(actions[0]?.notionalUsdc),
			limitPrice: Number(actions[0]?.limitPrice),
			clientOrderId: actions[0]?.clientOrderId ?? "missing",
			tokenId: actions[0]?.tokenId ?? "missing",
			conditionId: actions[0]?.conditionId ?? "missing",
			cohortKey: actions[0]?.cohortKey ?? "missing",
			targetWallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
		});
		expect(intent).toMatchObject({
			side: "BUY",
			attributes: { placement: "limit", orderType: "GTC" },
		});
	});

	it("atomically reduces and reserves planner shares across NUMERIC(30,12) rounding", async () => {
		const store = new PositionGapRuntimeStore(getSeedDb());
		const cohortKey = "quantized-cohort";
		const originalShares = 2.0000000000004;
		const reducedShares = 1.0000000000004;
		const persisted = await store.persistPlan({
			scope: {
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetQuantized,
			},
			triggerReasons: ["activation"],
			snapshot: {
				id: "snapshot-quantized",
				hash: "hash-quantized",
				asOf,
				expiresAt: new Date(asOf.getTime() + 600_000),
				value: { version: 1, complete: true },
			},
			plannerVersion: "test",
			budgetUsdc: 10,
			eligibleNetNavUsdc: 100,
			scale: 0.1,
			walletCashUsdc: 10,
			plan: { version: 1, status: "ready" },
			cohortCreations: [
				{
					cohortKey,
					sourceKind: "activation",
					sourceEventId: null,
					sourceConfigRevision: "rev-quantized",
					conditionId: "condition-quantized",
					tokenId: "token-quantized",
					marketId: "prediction-market:polymarket:condition-quantized",
					outcome: "0",
					targetDeltaShares: originalShares,
					scaleAtCreation: 1,
					allowedMirrorShares: originalShares,
					benchmarkTargetVwap: 0.5,
					remainingShares: originalShares,
					createdAtMs: asOf.getTime(),
					provenance: { created_at_ms: asOf.getTime() },
				},
			],
			cohortReductions: [
				{
					cohortId: cohortKey,
					cohortKey,
					previousAllowedMirrorShares: originalShares,
					allowedMirrorShares: reducedShares,
					remainingShares: reducedShares,
					status: "reduced",
				},
			],
			buys: [
				{
					actionKey: "quantized-buy",
					cohortKey,
					conditionId: "condition-quantized",
					tokenId: "token-quantized",
					marketId: "prediction-market:polymarket:condition-quantized",
					outcome: "0",
					shares: reducedShares,
					notionalUsdc: reducedShares * 0.5,
					limitPrice: 0.5,
					clientOrderId: "quantized-client",
					plannerAction: { side: "BUY" },
				},
			],
			cancellations: [],
		});

		expect(persisted.buys).toHaveLength(1);
		const [cohort] = await getSeedDb()
			.select()
			.from(polyPositionGapCohorts)
			.where(eq(polyPositionGapCohorts.cohortKey, cohortKey));
		expect(Number(cohort?.allowedMirrorShares)).toBe(1);
		expect(Number(cohort?.remainingShares)).toBe(0);
	});

	it("enforces FORCE RLS for owner, delegate, and stranger", async () => {
		const read = (principal: string) =>
			withTenantScope(appDb, userActor(toUserId(principal)), async (tx) => ({
				runs: await tx.select().from(polyPositionGapRuns),
				cohorts: await tx.select().from(polyPositionGapCohorts),
				actions: await tx.select().from(polyPositionGapActions),
				reservations: await tx.select().from(polyPositionGapReservations),
			}));
		const owner = await read(ownerA);
		const delegated = await read(delegate);
		const none = await read(stranger);
		expect(owner.runs.length).toBeGreaterThan(0);
		expect(delegated.runs).toHaveLength(owner.runs.length);
		expect(delegated.cohorts).toHaveLength(owner.cohorts.length);
		expect(delegated.actions).toHaveLength(owner.actions.length);
		expect(delegated.reservations).toHaveLength(owner.reservations.length);
		expect(none.runs).toEqual([]);
		expect(none.cohorts).toEqual([]);
		expect(none.actions).toEqual([]);
		expect(none.reservations).toEqual([]);

		const changed = await withTenantScope(
			appDb,
			userActor(toUserId(delegate)),
			(tx) =>
				tx
					.update(polyPositionGapRuns)
					.set({ status: "failed" })
					.where(eq(polyPositionGapRuns.billingAccountId, accountA))
					.returning({ id: polyPositionGapRuns.id }),
		);
		expect(changed).toEqual([]);
	});

	it("restores a runtime-safety cancel once and permits a fresh retry", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const scope = {
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetSafety,
		};
		const common = {
			scope,
			triggerReasons: ["activation"],
			snapshot: {
				id: "snapshot-safety",
				hash: "hash-safety",
				asOf,
				expiresAt: new Date(asOf.getTime() + 600_000),
				value: { version: 1, complete: true },
			},
			plannerVersion: "test",
			budgetUsdc: 10,
			eligibleNetNavUsdc: 100,
			scale: 0.1,
			walletCashUsdc: 20,
			plan: { version: 1, status: "ready" },
			cohortReductions: [],
		};
		const cohortKey = "safety-cohort";
		const initial = await store.persistPlan({
			...common,
			cohortCreations: [
				{
					cohortKey,
					sourceKind: "activation" as const,
					sourceEventId: null,
					sourceConfigRevision: "rev-safety",
					conditionId: "condition-safety",
					tokenId: "token-safety",
					marketId: "prediction-market:polymarket:condition-safety",
					outcome: "0",
					targetDeltaShares: 4,
					scaleAtCreation: 1,
					allowedMirrorShares: 4,
					benchmarkTargetVwap: 0.5,
					remainingShares: 4,
					createdAtMs: asOf.getTime(),
					provenance: { created_at_ms: asOf.getTime() },
				},
			],
			buys: [
				{
					actionKey: "safety-buy-1",
					cohortKey,
					conditionId: "condition-safety",
					tokenId: "token-safety",
					marketId: "prediction-market:polymarket:condition-safety",
					outcome: "0",
					shares: 4,
					notionalUsdc: 2,
					limitPrice: 0.5,
					clientOrderId: "safety-client-1",
					plannerAction: { side: "BUY" },
				},
			],
			cancellations: [],
		});
		const buy = initial.buys[0];
		expect(buy).toBeDefined();
		await store.markLedgered(buy?.id ?? "missing");
		await store.markSubmitting(buy?.id ?? "missing");
		await store.markPlacementReceipt(buy?.id ?? "missing", {
			order_id: "safety-order-1",
			client_order_id: "safety-client-1",
			status: "open",
			filled_size_usdc: 0,
			submitted_at: asOf.toISOString(),
		});

		const cancellation = await store.persistPlan({
			...common,
			triggerReasons: ["stale_snapshot"],
			cohortCreations: [],
			buys: [],
			cancellations: [
				{
					actionKey: "safety-cancel-1",
					cohortKey,
					orderId: "safety-order-1",
					reason: "runtime_safety",
					plannerAction: { reason: "runtime_safety" },
				},
			],
		});
		const cancel = cancellation.cancellations[0];
		expect(cancel).toBeDefined();
		await store.markCancelConfirmed(cancel?.id ?? "missing");
		await store.markCancelConfirmed(cancel?.id ?? "missing");

		const [restored] = await db
			.select()
			.from(polyPositionGapCohorts)
			.where(eq(polyPositionGapCohorts.cohortKey, cohortKey));
		const [releasedReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, buy?.id ?? "missing"));
		expect(Number(restored?.remainingShares)).toBe(4);
		expect(Number(restored?.openOrderShares)).toBe(0);
		expect(releasedReservation?.state).toBe("released");
		expect(Number(releasedReservation?.releasedBudgetUsdc)).toBe(2);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBe(0);

		const retry = await store.persistPlan({
			...common,
			triggerReasons: ["timer"],
			cohortCreations: [],
			buys: [
				{
					actionKey: "safety-buy-2",
					cohortKey,
					conditionId: "condition-safety",
					tokenId: "token-safety",
					marketId: "prediction-market:polymarket:condition-safety",
					outcome: "0",
					shares: 4,
					notionalUsdc: 2,
					limitPrice: 0.5,
					clientOrderId: "safety-client-2",
					plannerAction: { side: "BUY" },
				},
			],
			cancellations: [],
		});
		expect(retry.buys).toHaveLength(1);
	});

	it("recovers a durable allowance rejection but keeps transport ambiguity blocked", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const scope = {
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetAmbiguousRejection,
		};
		const persistBuy = async (suffix: string) => {
			const cohortKey = `ambiguous-cohort-${suffix}`;
			return store.persistPlan({
				scope,
				triggerReasons: ["activation"],
				snapshot: {
					id: `ambiguous-snapshot-${suffix}`,
					hash: `ambiguous-hash-${suffix}`,
					asOf,
					expiresAt: future,
					value: { version: 1, complete: true },
				},
				plannerVersion: "test",
				budgetUsdc: 10,
				eligibleNetNavUsdc: 100,
				scale: 0.1,
				walletCashUsdc: 20,
				plan: { version: 1, status: "ready" },
				cohortCreations: [
					{
						cohortKey,
						sourceKind: "activation" as const,
						sourceEventId: null,
						sourceConfigRevision: "rev-ambiguous",
						conditionId: `condition-${suffix}`,
						tokenId: `token-${suffix}`,
						marketId: `prediction-market:polymarket:condition-${suffix}`,
						outcome: "0",
						targetDeltaShares: 4,
						scaleAtCreation: 1,
						allowedMirrorShares: 4,
						benchmarkTargetVwap: 0.5,
						remainingShares: 4,
						createdAtMs: asOf.getTime(),
						provenance: { created_at_ms: asOf.getTime() },
					},
				],
				cohortReductions: [],
				buys: [
					{
						actionKey: `ambiguous-buy-${suffix}`,
						cohortKey,
						conditionId: `condition-${suffix}`,
						tokenId: `token-${suffix}`,
						marketId: `prediction-market:polymarket:condition-${suffix}`,
						outcome: "0",
						shares: 4,
						notionalUsdc: 2,
						limitPrice: 0.5,
						clientOrderId: `ambiguous-client-${suffix}`,
						plannerAction: { side: "BUY" },
					},
				],
				cancellations: [],
			});
		};
		const ledger = createOrderLedger({
			db,
			logger: {
				debug: () => undefined,
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				child() {
					return this;
				},
			} as never, // MODE_STAMPED_FROM_ACCOUNT: the ledger resolves each write's mode from the
			// writing row's own billing account, never a process-wide env read. These
			// are live fixtures; stating the venue explicitly keeps the test honest
			// rather than leaning on a default production deliberately does not have.
			resolveExecutionMode: async () => "live" as const,
		});

		const hard = await persistBuy("hard");
		const hardBuy = hard.buys[0];
		if (!hardBuy) throw new Error("hard rejection BUY missing");
		await ledger.insertPending({
			billing_account_id: accountA,
			created_by_user_id: ownerA,
			target_id: targetAmbiguousRejection,
			fill_id: "position-gap-v3:ambiguous-buy-hard",
			observed_at: asOf,
			intent: buildPositionGapBuyIntent({
				marketId: "prediction-market:polymarket:condition-hard",
				outcome: "0",
				notionalUsdc: 2,
				limitPrice: 0.5,
				clientOrderId: "ambiguous-client-hard",
				tokenId: "token-hard",
				conditionId: "condition-hard",
				cohortKey: "ambiguous-cohort-hard",
				targetWallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
			}),
		});
		await store.markLedgered(hardBuy.id);
		await store.markSubmitting(hardBuy.id);
		const durableDetail =
			'PolymarketClobAdapter.placeOrder: CLOB rejected order (error_code=insufficient_allowance, response_keys=[success,errorMsg], reason="insufficient_allowance", clob_error="not enough balance / allowance: the allowance is not enough")';
		await store.markAmbiguous(hardBuy.id, durableDetail);

		await expect(store.recoverKnownRejectedAmbiguities(scope)).resolves.toEqual(
			[
				{
					id: hardBuy.id,
					clientOrderId: "ambiguous-client-hard",
					errorCode: "insufficient_allowance",
				},
			],
		);
		await expect(store.recoverKnownRejectedAmbiguities(scope)).resolves.toEqual(
			[],
		);

		const [hardAction] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, hardBuy.id));
		const [hardReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, hardBuy.id));
		const [hardCohort] = await db
			.select()
			.from(polyPositionGapCohorts)
			.where(eq(polyPositionGapCohorts.cohortKey, "ambiguous-cohort-hard"));
		const [hardLedger] = await db
			.select()
			.from(polyCopyTradeFills)
			.where(eq(polyCopyTradeFills.clientOrderId, "ambiguous-client-hard"));
		expect(hardAction).toMatchObject({
			status: "rejected",
			errorCode: "placement_rejected",
			errorDetail: durableDetail,
		});
		expect(hardReservation).toMatchObject({
			state: "released",
			releaseReason: "known_rejected",
		});
		expect(Number(hardCohort?.openOrderShares)).toBe(0);
		expect(Number(hardCohort?.remainingShares)).toBe(4);
		expect(hardLedger).toMatchObject({ status: "error" });
		expect(hardLedger?.attributes).toMatchObject({ error: durableDetail });

		const transport = await persistBuy("transport");
		const transportBuy = transport.buys[0];
		if (!transportBuy) throw new Error("transport BUY missing");
		await store.markLedgered(transportBuy.id);
		await store.markSubmitting(transportBuy.id);
		await store.markAmbiguous(transportBuy.id, "connection reset after submit");
		await expect(store.recoverKnownRejectedAmbiguities(scope)).resolves.toEqual(
			[],
		);
		const [transportAction] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, transportBuy.id));
		expect(transportAction?.status).toBe("ambiguous");
		await expect(
			store.persistPlan({
				scope,
				triggerReasons: ["disabled"],
				snapshot: {
					id: "blocked-snapshot",
					hash: "blocked-hash",
					asOf,
					expiresAt: future,
					value: { version: 1, complete: true },
				},
				plannerVersion: "test",
				budgetUsdc: 10,
				eligibleNetNavUsdc: 0,
				scale: 0,
				walletCashUsdc: 20,
				plan: { version: 1, status: "blocked" },
				cohortCreations: [],
				cohortReductions: [],
				buys: [],
				cancellations: [],
			}),
		).rejects.toThrow("halted by an ambiguous placement");

		// A generic transport ambiguity remains fail-closed until durable ledger
		// evidence proves no venue order exists. The actor maps that evidence to
		// this narrow transition; it must retire the action and release its
		// reservation so a replacement generation can start safely.
		await store.markVenueNotFoundCanceled(transportBuy.id);
		const [retiredTransportAction] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, transportBuy.id));
		const [retiredTransportReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, transportBuy.id));
		expect(retiredTransportAction).toMatchObject({
			status: "canceled",
			errorCode: "clob_not_found",
		});
		expect(retiredTransportReservation).toMatchObject({
			state: "released",
			releaseReason: "clob_not_found",
		});
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBe(0);
	});

	it("rejects a second live ledger row for the same v3 cohort before placement", async () => {
		const db = getSeedDb();
		const logger = {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			child() {
				return this;
			},
		};
		const ledger = createOrderLedger({
			db,
			logger: logger as never,
			// MODE_STAMPED_FROM_ACCOUNT: the ledger resolves each write's mode from
			// the writing row's own billing account rather than a process-wide env
			// read. These rows are live fixtures, so the venue is "live"; supplying
			// the resolver explicitly keeps the test honest about that rather than
			// relying on a default the production ledger deliberately does not have.
			resolveExecutionMode: async () => "live" as const,
		});
		const insert = (suffix: string) =>
			ledger.insertPending({
				billing_account_id: accountA,
				created_by_user_id: ownerA,
				target_id: targetA,
				fill_id: `position-gap-v3-ledger-${suffix}`,
				observed_at: asOf,
				intent: {
					provider: "polymarket",
					market_id: "prediction-market:polymarket:condition-ledger",
					outcome: "0",
					side: "BUY",
					size_usdc: 1,
					limit_price: 0.5,
					client_order_id: `position-gap-v3-client-${suffix}`,
					attributes: {
						token_id: "token-ledger",
						position_gap_version: "3",
						position_gap_cohort_key: "cohort-ledger",
						placement: "limit",
					},
				},
			});

		await insert("first");
		await expect(insert("second")).rejects.toThrow();
	});

	it("atomically upgrades ledger fill accounting without share regression", async () => {
		const db = getSeedDb();
		const logger = {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
			child() {
				return this;
			},
		};
		const ledger = createOrderLedger({
			db,
			logger: logger as never,
			// MODE_STAMPED_FROM_ACCOUNT: the ledger resolves each write's mode from
			// the writing row's own billing account rather than a process-wide env
			// read. These rows are live fixtures, so the venue is "live"; supplying
			// the resolver explicitly keeps the test honest about that rather than
			// relying on a default the production ledger deliberately does not have.
			resolveExecutionMode: async () => "live" as const,
		});
		const clientOrderId = `fill-accounting-${randomUUID()}`;
		await ledger.insertPending({
			billing_account_id: accountA,
			created_by_user_id: ownerA,
			target_id: targetA,
			fill_id: `position-gap-v3:${clientOrderId}`,
			observed_at: asOf,
			intent: {
				provider: "polymarket",
				market_id: `prediction-market:polymarket:${clientOrderId}`,
				outcome: "0",
				side: "BUY",
				size_usdc: 6,
				limit_price: 0.5,
				client_order_id: clientOrderId,
				attributes: { token_id: clientOrderId },
			},
		});
		await db
			.update(polyCopyTradeFills)
			.set({
				price: "0.002",
				shares: "12",
				attributes: {
					filled_size_usdc: 0.024,
					realized_fill_source: "data_api_activity_position",
				},
			})
			.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));

		await Promise.all([
			ledger.markOrderId({
				client_order_id: clientOrderId,
				receipt: {
					order_id: "venue-fill-accounting",
					client_order_id: clientOrderId,
					status: "open",
					filled_size_usdc: 4,
					fill_price: 4 / 12,
					total_shares: 12,
					submitted_at: asOf.toISOString(),
				},
			}),
			ledger.updateStatus({
				client_order_id: clientOrderId,
				status: "filled",
				filled_size_usdc: 0.012,
				fill_price: 0.001,
				total_shares: 12,
				realized_fill_source: "clob_associated_trades",
			}),
		]);
		await ledger.updateStatus({
			client_order_id: clientOrderId,
			status: "open",
			filled_size_usdc: 0.0005,
			fill_price: 0.00008,
			total_shares: 6,
			realized_fill_source: "clob_associated_trades",
		});

		const [row] = await db
			.select()
			.from(polyCopyTradeFills)
			.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));
		expect(Number(row?.shares)).toBe(12);
		expect(row?.status).toBe("filled");
		expect(Number(row?.price)).toBe(0.001);
		expect(Number(row?.attributes?.filled_size_usdc)).toBe(0.012);
		expect(row?.attributes?.realized_fill_source).toBe(
			"clob_associated_trades",
		);
	});

	it("atomically repairs a pruned PGv3 fill from exact Data API evidence", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const targetId = randomUUID();
		const runId = randomUUID();
		const cohortId = randomUUID();
		const actionId = randomUUID();
		const clientOrderId = `data-api-repair-${randomUUID()}`;
		const orderId = `0x${"1".repeat(64)}`;
		const scope = {
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId,
		};
		await db.insert(polyPositionGapRuns).values({
			id: runId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId,
			budgetUsdc: "10",
			walletCashUsdcAtStart: "10",
			status: "completed",
			completedAt: asOf,
		});
		await db.insert(polyPositionGapCohorts).values({
			id: cohortId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId,
			cohortKey: "data-api-repair-cohort",
			sourceKind: "activation",
			sourceConfigRevision: "rev",
			sourceSnapshotId: "snapshot",
			sourceSnapshotHash: "hash",
			sourceSnapshotAsOf: asOf,
			sourceProvenance: {},
			createdRunId: runId,
			conditionId: "condition-data-api-repair",
			tokenId: "token-data-api-repair",
			marketId: "prediction-market:polymarket:condition-data-api-repair",
			outcome: "1",
			targetDeltaShares: "9.3",
			scaleAtCreation: "1",
			allowedMirrorShares: "9.3",
			initialAllowedMirrorShares: "9.3",
			benchmarkTargetVwap: "0.3867",
			acquiredShares: "9.3",
			remainingShares: "0",
			status: "exhausted",
		});
		await db.insert(polyPositionGapActions).values({
			id: actionId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId,
			runId,
			cohortId,
			cohortKey: "data-api-repair-cohort",
			actionKey: "data-api-repair-action",
			kind: "buy",
			conditionId: "condition-data-api-repair",
			tokenId: "token-data-api-repair",
			marketId: "prediction-market:polymarket:condition-data-api-repair",
			outcome: "1",
			desiredShares: "9.306",
			filledShares: "9.3",
			filledUsdc: "3.5898",
			notionalUsdc: "3.592216",
			limitPrice: "0.386",
			plannerAction: { fill_accounting_status: "pending" },
			clientOrderId,
			orderId,
			status: "filled",
			submitStartedAt: new Date("2026-10-08T04:47:47.865Z"),
			completedAt: new Date("2026-10-08T04:48:00.000Z"),
		});
		await db.insert(polyPositionGapReservations).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId,
			cohortId,
			buyActionId: actionId,
			budgetNotionalUsdc: "3.592216",
			executorCashGuardAtomic: "3951438",
			cashGuardSource: "test",
			filledCostUsdc: "3.5898",
		});
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId,
			fillId: "position-gap-v3:data-api-repair-action",
			marketId: "prediction-market:polymarket:condition-data-api-repair",
			observedAt: asOf,
			clientOrderId,
			orderId,
			status: "filled",
			price: "0.386",
			shares: "9.3",
			attributes: {
				position_gap_version: "3",
				filled_size_usdc: 3.5898,
			},
		});

		const evidence = {
			status: "verified" as const,
			source: "data_api_activity_position" as const,
			wallet: "0x8ca45685c5827f7acfdd890214180c4ea9d0bf58" as const,
			shares: 9.3,
			filledUsdc: 0.009295,
			grossCashUsdc: 0.00976,
			fillPrice: 0.009295 / 9.3,
			feesUsdc: 0.00046,
			transactionHashes: [`0x${"2".repeat(64)}`],
			evidenceStart: "2026-10-08T04:47:42.000Z",
			evidenceEnd: "2026-10-08T04:48:30.000Z",
		};
		expect(
			await store.markFillAccountingMismatch(
				scope,
				actionId,
				"missing_activity",
				"no exact activity yet",
			),
		).toMatchObject({
			from: "pending",
			to: "mismatch",
			reason: "missing_activity",
		});
		expect(
			await store.applyDataApiFillAccounting(scope, actionId, evidence),
		).toMatchObject({ from: "mismatch", to: "verified" });
		expect(
			await store.applyDataApiFillAccounting(scope, actionId, evidence),
		).toMatchObject({ from: "verified", to: "verified" });
		const ledgerPort = createOrderLedger({
			db,
			logger: {
				debug: () => undefined,
				info: () => undefined,
				warn: () => undefined,
				error: () => undefined,
				child() {
					return this;
				},
			} as never, // MODE_STAMPED_FROM_ACCOUNT: the ledger resolves each write's mode from the
			// writing row's own billing account, never a process-wide env read. These
			// are live fixtures; stating the venue explicitly keeps the test honest
			// rather than leaning on a default production deliberately does not have.
			resolveExecutionMode: async () => "live" as const,
		});
		await ledgerPort.markOrderId({
			client_order_id: clientOrderId,
			receipt: {
				order_id: orderId,
				client_order_id: clientOrderId,
				status: "filled",
				filled_size_usdc: 1,
				fill_price: 0.1,
				total_shares: 10,
				submitted_at: "2026-10-08T04:47:47.865Z",
			},
		});
		await expect(
			store.applyDataApiFillAccounting(
				{ ...scope, targetId: targetB },
				actionId,
				evidence,
			),
		).rejects.toThrow("attribution changed");

		const [action] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, actionId));
		const [ledger] = await db
			.select()
			.from(polyCopyTradeFills)
			.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));
		const [reservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, actionId));
		expect(Number(action?.filledUsdc)).toBe(0.009295);
		expect(action?.plannerAction.realized_fill_source).toBe(
			"data_api_activity_position",
		);
		expect(ledger?.status).toBe("filled");
		expect(Number(ledger?.price)).toBeCloseTo(0.009295 / 9.3, 8);
		expect(Number(ledger?.shares)).toBe(9.3);
		expect(Number(ledger?.feesUsdc)).toBe(0.00046);
		expect(ledger?.attributes?.filled_size_usdc).toBe(0.009295);
		expect(ledger?.attributes?.fill_accounting_gross_cash_usdc).toBe(0.00976);
		expect(ledger?.attributes?.realized_fill_source).toBe(
			"data_api_activity_position",
		);
		expect(Number(reservation?.filledCostUsdc)).toBe(0.00976);

		// Crash window 1: the runtime action committed authoritative CLOB
		// accounting while the ledger and reservation retained older Data evidence.
		await db
			.update(polyPositionGapActions)
			.set({
				filledUsdc: "0.008",
				plannerAction: {
					...action?.plannerAction,
					realized_fill_source: "clob_associated_trades",
					fill_accounting_status: "verified",
				},
			})
			.where(eq(polyPositionGapActions.id, actionId));
		await db
			.update(polyCopyTradeFills)
			.set({
				price: evidence.fillPrice.toString(),
				feesUsdc: evidence.feesUsdc.toString(),
				attributes: {
					...ledger?.attributes,
					filled_size_usdc: evidence.filledUsdc,
					realized_fill_source: "data_api_activity_position",
				},
			})
			.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));
		await db
			.update(polyPositionGapReservations)
			.set({ filledCostUsdc: evidence.grossCashUsdc.toString() })
			.where(eq(polyPositionGapReservations.buyActionId, actionId));
		expect(
			await store.applyDataApiFillAccounting(scope, actionId, evidence),
		).toMatchObject({ source: "clob_associated_trades", to: "verified" });

		let [convergedAction] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, actionId));
		let [convergedLedger] = await db
			.select()
			.from(polyCopyTradeFills)
			.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));
		let [convergedReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, actionId));
		expect(Number(convergedAction?.filledUsdc)).toBe(0.008);
		expect(convergedLedger?.attributes?.realized_fill_source).toBe(
			"clob_associated_trades",
		);
		expect(Number(convergedLedger?.attributes?.filled_size_usdc)).toBe(0.008);
		expect(Number(convergedReservation?.filledCostUsdc)).toBe(0.00846);

		// Crash window 2: the ledger committed authoritative CLOB accounting while
		// the runtime action and reservation retained older Data evidence.
		await db
			.update(polyPositionGapActions)
			.set({
				filledUsdc: evidence.filledUsdc.toString(),
				plannerAction: {
					...convergedAction?.plannerAction,
					realized_fill_source: "data_api_activity_position",
					fill_accounting_status: "verified",
				},
			})
			.where(eq(polyPositionGapActions.id, actionId));
		await db
			.update(polyCopyTradeFills)
			.set({
				price: (0.012 / 9.3).toString(),
				shares: "9.3",
				feesUsdc: "0.0003",
				attributes: {
					...convergedLedger?.attributes,
					filled_size_usdc: 0.012,
					realized_fill_source: "clob_associated_trades",
				},
			})
			.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));
		await db
			.update(polyPositionGapReservations)
			.set({ filledCostUsdc: evidence.grossCashUsdc.toString() })
			.where(eq(polyPositionGapReservations.buyActionId, actionId));
		expect(
			await store.applyDataApiFillAccounting(scope, actionId, evidence),
		).toMatchObject({ source: "clob_associated_trades", to: "verified" });
		expect(
			await store.applyDataApiFillAccounting(scope, actionId, evidence),
		).toMatchObject({ source: "clob_associated_trades", to: "verified" });
		[convergedAction] = await db
			.select()
			.from(polyPositionGapActions)
			.where(eq(polyPositionGapActions.id, actionId));
		[convergedLedger] = await db
			.select()
			.from(polyCopyTradeFills)
			.where(eq(polyCopyTradeFills.clientOrderId, clientOrderId));
		[convergedReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, actionId));
		expect(Number(convergedAction?.filledUsdc)).toBe(0.012);
		expect(convergedAction?.plannerAction.realized_fill_source).toBe(
			"clob_associated_trades",
		);
		expect(Number(convergedLedger?.attributes?.filled_size_usdc)).toBe(0.012);
		expect(Number(convergedReservation?.filledCostUsdc)).toBe(0.0123);
		// Reservation release is monotonic: a later authoritative cost correction
		// cannot re-reserve budget that the executor already made available.
		expect(Number(convergedReservation?.releasedBudgetUsdc)).toBeCloseTo(
			3.592216 - 0.00846,
			8,
		);
	});

	it("consumes durable CLOB not_found before a stop retry and releases only unfilled", async () => {
		const db = getSeedDb();
		const store = new PositionGapRuntimeStore(db);
		const runId = randomUUID();
		const cohortId = randomUUID();
		const actionId = randomUUID();
		await db.insert(polyPositionGapRuns).values({
			id: runId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetNotFound,
			budgetUsdc: "10",
			walletCashUsdcAtStart: "10",
			status: "completed",
		});
		await db.insert(polyPositionGapCohorts).values({
			id: cohortId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetNotFound,
			cohortKey: "not-found-cohort",
			sourceKind: "activation",
			sourceConfigRevision: "rev",
			sourceSnapshotId: "snapshot",
			sourceSnapshotHash: "hash",
			sourceSnapshotAsOf: asOf,
			sourceProvenance: {},
			createdRunId: runId,
			conditionId: "condition-not-found",
			tokenId: "token-not-found",
			marketId: "prediction-market:polymarket:condition-not-found",
			outcome: "0",
			targetDeltaShares: "10",
			scaleAtCreation: "1",
			allowedMirrorShares: "10",
			initialAllowedMirrorShares: "10",
			benchmarkTargetVwap: "0.5",
			acquiredShares: "4",
			openOrderShares: "6",
			remainingShares: "0",
			status: "resting",
		});
		await db.insert(polyPositionGapActions).values({
			id: actionId,
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetNotFound,
			runId,
			cohortId,
			cohortKey: "not-found-cohort",
			actionKey: "not-found-action",
			kind: "buy",
			conditionId: "condition-not-found",
			tokenId: "token-not-found",
			marketId: "prediction-market:polymarket:condition-not-found",
			outcome: "0",
			desiredShares: "10",
			filledShares: "4",
			filledUsdc: "2",
			notionalUsdc: "5",
			limitPrice: "0.5",
			plannerAction: {},
			clientOrderId: "not-found-client",
			orderId: "not-found-order",
			status: "partial",
		});
		await db.insert(polyPositionGapReservations).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetNotFound,
			cohortId,
			buyActionId: actionId,
			budgetNotionalUsdc: "5",
			executorCashGuardAtomic: "5500000",
			cashGuardSource: "test",
		});
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: accountA,
			createdByUserId: ownerA,
			targetId: targetNotFound,
			fillId: "position-gap-v3:not-found-action",
			marketId: "prediction-market:polymarket:condition-not-found",
			observedAt: asOf,
			clientOrderId: "not-found-client",
			orderId: "not-found-order",
			status: "canceled",
			attributes: { reason: "clob_not_found" },
		});

		expect(
			await store.reconcileLedgerTerminals({
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetNotFound,
			}),
		).toBe(1);
		expect(
			await store.reconcileLedgerTerminals({
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetNotFound,
			}),
		).toBe(0);
		const [reservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, actionId));
		const [cohort] = await db
			.select()
			.from(polyPositionGapCohorts)
			.where(eq(polyPositionGapCohorts.id, cohortId));
		expect(Number(reservation?.releasedBudgetUsdc)).toBe(5);
		expect(reservation?.state).toBe("released");
		expect(Number(cohort?.acquiredShares)).toBe(4);
		expect(Number(cohort?.openOrderShares)).toBe(0);
		expect(Number(cohort?.remainingShares)).toBe(6);
	});
});
