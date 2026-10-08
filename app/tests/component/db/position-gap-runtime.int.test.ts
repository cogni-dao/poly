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
import {
	PositionGapReservationConflictError,
	PositionGapRuntimeStore,
} from "@/features/copy-trade/position-gap-runtime-store";
import {
	createOrderLedger,
} from "@/features/trading/order-ledger";
import { billingAccounts, users } from "@/shared/db/schema";

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
		expect(Number(filledAction?.filledUsdc)).toBe(4);
		expect(Number(filledReservation?.releasedBudgetUsdc)).toBe(2);
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
		expect(Number(restored?.remainingShares)).toBe(4);
		expect(Number(restored?.openOrderShares)).toBe(0);

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
		const ledger = createOrderLedger({ db, logger: logger as never });
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
		expect(Number(reservation?.releasedBudgetUsdc)).toBe(3);
		expect(reservation?.state).toBe("active");
		expect(Number(cohort?.acquiredShares)).toBe(4);
		expect(Number(cohort?.openOrderShares)).toBe(0);
		expect(Number(cohort?.remainingShares)).toBe(6);
	});
});
