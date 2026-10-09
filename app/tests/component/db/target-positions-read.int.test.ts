// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres proof for the bounded, tenant-clamped target-position view. */

import { randomUUID } from "node:crypto";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import { polyPositionGapRuns } from "@cogni/db-schema/position-gap";
import { toUserId, userActor } from "@cogni/ids";
import {
	polyMarketMetadata,
	polyTraderCurrentPositions,
	polyTraderIngestionCursors,
	polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { PolyAccountTargetPositionsResponseSchema } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import {
	decodeTargetPositionCursor,
	encodeTargetPositionCursor,
	InvalidTargetPositionCursorError,
	getTargetPositionsForAccount as readTargetPositionsForAccount,
	targetPositionRowsSelect,
} from "@/features/wallet-analysis/server/target-positions-read";
import {
	COPY_TARGET_POSITION_CURSOR_SOURCE,
} from "@/features/wallet-analysis/server/position-observation-sources";
import {
	billingAccounts,
	polyCopyTradeTargets,
	users,
} from "@/shared/db/schema";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const suffix = randomUUID().replaceAll("-", "");
const USER_A = randomUUID();
const USER_B = randomUUID();
const USER_EMPTY = randomUUID();
const USER_MANY = randomUUID();
const ACCOUNT_A = randomUUID();
const ACCOUNT_B = randomUUID();
const ACCOUNT_EMPTY = randomUUID();
const ACCOUNT_MANY = randomUUID();
const TARGET_A = `0x${suffix.slice(0, 40).padEnd(40, "a")}`;
const TARGET_PARTIAL = `0x${suffix.slice(0, 40).padEnd(40, "b")}`;
const TARGET_OTHER = `0x${suffix.slice(0, 40).padEnd(40, "c")}`;
const CONDITION_A = `0x${suffix}${"1".repeat(32)}`;
const CONDITION_B = `0x${suffix}${"2".repeat(32)}`;
const CONDITION_OTHER = `0x${suffix}${"3".repeat(32)}`;
const CONDITION_RUNTIME = `0x${suffix}${"4".repeat(32)}`;
const RUNTIME_TARGET_ID = targetIdFromWallet(TARGET_A);
const PARTIAL_RUNTIME_TARGET_ID = targetIdFromWallet(TARGET_PARTIAL);
const MANY_TARGETS = Array.from(
	{ length: 51 },
	(_, index) =>
		`0x${suffix}${index.toString(16).padStart(8, "0")}` as `0x${string}`,
);
const MANY_TARGET = MANY_TARGETS[50] as `0x${string}`;
const MANY_RUNTIME_TARGET_ID = targetIdFromWallet(MANY_TARGET);
const MANY_CONDITION = `0x${suffix}${"5".repeat(32)}`;
const future = new Date("2099-01-01T00:00:00.000Z");
const now = new Date();
const TEST_BINDING = {
	resolveEffectiveKind: (
		_targetWallet: `0x${string}`,
		configuredKind:
			| "auto"
			| "min_bet"
			| "target_percentile_scaled"
			| "position_gap"
			| "mirror_fill_exact",
	) => (configuredKind === "auto" ? ("min_bet" as const) : configuredKind),
};
const getTargetPositionsForAccount = (
	tx: AgentGrantTransaction,
	accountId: string,
	query: Parameters<typeof readTargetPositionsForAccount>[2],
) => readTargetPositionsForAccount(tx, accountId, query, TEST_BINDING);

describe("target positions persisted target/runtime read", () => {
	const db = getSeedDb();
	let targetWalletId = "";
	let partialWalletId = "";
	let otherWalletId = "";
	let manyRunId = "";

	beforeAll(async () => {
		await db.insert(users).values([
			{ id: USER_A, name: USER_A, walletAddress: TARGET_A },
			{ id: USER_B, name: USER_B, walletAddress: TARGET_OTHER },
			{ id: USER_EMPTY, name: USER_EMPTY },
			{ id: USER_MANY, name: USER_MANY },
		]);
		await db.insert(billingAccounts).values([
			{ id: ACCOUNT_A, ownerUserId: USER_A, balanceCredits: 0n },
			{ id: ACCOUNT_B, ownerUserId: USER_B, balanceCredits: 0n },
			{ id: ACCOUNT_EMPTY, ownerUserId: USER_EMPTY, balanceCredits: 0n },
			{ id: ACCOUNT_MANY, ownerUserId: USER_MANY, balanceCredits: 0n },
		]);
		await db.insert(agentCapabilityGrants).values({
			billingAccountId: ACCOUNT_A,
			granteePrincipalId: USER_B,
			scopes: ["account:read"],
			expiresAt: future,
			createdByUserId: USER_A,
		});
		await db.insert(polyCopyTradeTargets).values([
			{
				billingAccountId: ACCOUNT_A,
				createdByUserId: USER_A,
				targetWallet: TARGET_A,
				sizingPolicyKind: "position_gap",
			},
			{
				billingAccountId: ACCOUNT_A,
				createdByUserId: USER_A,
				targetWallet: TARGET_PARTIAL,
			},
			{
				billingAccountId: ACCOUNT_B,
				createdByUserId: USER_B,
				targetWallet: TARGET_OTHER,
			},
		]);
		await db.insert(polyCopyTradeTargets).values(
			MANY_TARGETS.map((targetWallet, index) => ({
				billingAccountId: ACCOUNT_MANY,
				createdByUserId: USER_MANY,
				targetWallet,
				...(index === MANY_TARGETS.length - 1
					? { sizingPolicyKind: "position_gap" as const }
					: {}),
			})),
		);
		const wallets = await db
			.insert(polyTraderWallets)
			.values([
				{
					walletAddress: TARGET_A,
					kind: "copy_target",
					label: "RN1 test",
				},
				{
					walletAddress: TARGET_PARTIAL,
					kind: "copy_target",
					label: "Partial target",
				},
				{
					walletAddress: TARGET_OTHER,
					kind: "copy_target",
					label: "Other tenant",
				},
			])
			.returning({
				id: polyTraderWallets.id,
				wallet: polyTraderWallets.walletAddress,
			});
		targetWalletId = wallets.find((row) => row.wallet === TARGET_A)?.id ?? "";
		partialWalletId =
			wallets.find((row) => row.wallet === TARGET_PARTIAL)?.id ?? "";
		otherWalletId =
			wallets.find((row) => row.wallet === TARGET_OTHER)?.id ?? "";
		if (!targetWalletId || !partialWalletId || !otherWalletId) {
			throw new Error("wallet seed failed");
		}

		await db.insert(polyTraderIngestionCursors).values([
			{
				traderWalletId: targetWalletId,
				source: COPY_TARGET_POSITION_CURSOR_SOURCE,
				status: "ok",
				lastSuccessAt: now,
			},
			{
				traderWalletId: targetWalletId,
				source: "data-api-positions",
				status: "partial",
				lastSuccessAt: new Date("2026-10-03T00:00:00.000Z"),
			},
			{
				traderWalletId: partialWalletId,
				source: COPY_TARGET_POSITION_CURSOR_SOURCE,
				status: "partial",
				lastSuccessAt: now,
			},
			{
				traderWalletId: otherWalletId,
				source: COPY_TARGET_POSITION_CURSOR_SOURCE,
				status: "ok",
				lastSuccessAt: now,
			},
		]);
		await db.insert(polyMarketMetadata).values([
			{
				conditionId: CONDITION_A,
				marketTitle: "Will the target win?",
				marketSlug: "will-the-target-win",
				eventSlug: "target-event",
			},
			{
				conditionId: CONDITION_B,
				marketTitle: "Second target market",
				marketSlug: "second-target-market",
			},
			{
				conditionId: CONDITION_OTHER,
				marketTitle: "Other tenant market",
			},
			{
				conditionId: CONDITION_RUNTIME,
				marketTitle: "Runtime-only market",
				marketSlug: "runtime-only-market",
			},
		]);
		await db.insert(polyPositionGapRuns).values({
			billingAccountId: ACCOUNT_A,
			createdByUserId: USER_A,
			targetId: RUNTIME_TARGET_ID,
			triggerReasons: ["timer"],
			targetSnapshotId: "target-book-runtime",
			targetSnapshotAsOf: now,
			targetSnapshotExpiresAt: future,
			targetSnapshot: { complete: true },
			plannerVersion: "position-gap-v3-test",
			budgetUsdc: "24",
			eligibleNetNavUsdc: "100",
			scale: "0.24",
			walletCashUsdcAtStart: "25",
			status: "completed",
			completedAt: now,
			plan: {
				status: "no_feasible_position",
				blockReason: null,
				eligibleNetNavUsdc: 100,
				scale: 0.24,
				sleeveBudgetUsdc: 24,
				minimumFeasibleSleeveUsdc: 111.33,
				intents: [],
				lockedOverweights: [],
				diagnostics: [
					{
						conditionId: CONDITION_A,
						tokenId: "token-a",
						cohortId: "cohort-saved",
						reason: "no_gap",
						desiredShares: 10,
						heldShares: 10,
						openShares: 0,
						gapShares: 0,
						targetWeight: 0.75,
						limitPrice: 0.5,
						floorNotionalUsdc: 2.5,
						minimumSleeveUsdc: null,
					},
					{
						conditionId: CONDITION_RUNTIME,
						tokenId: "runtime-token",
						cohortId: "cohort-runtime",
						reason: "below_market_floor",
						desiredShares: 1.1,
						heldShares: 0,
						openShares: 0,
						gapShares: 1.1,
						targetWeight: 0.25,
						limitPrice: 0.85,
						floorNotionalUsdc: 4.25,
						minimumSleeveUsdc: 111.33,
					},
				],
			},
		});
		await db.insert(polyPositionGapRuns).values({
			billingAccountId: ACCOUNT_A,
			createdByUserId: USER_A,
			targetId: PARTIAL_RUNTIME_TARGET_ID,
			triggerReasons: ["timer"],
			targetSnapshotId: "historical-position-gap-run",
			targetSnapshotAsOf: now,
			targetSnapshotExpiresAt: future,
			targetSnapshot: { complete: true },
			plannerVersion: "position-gap-v3-historical",
			budgetUsdc: "24",
			eligibleNetNavUsdc: "100",
			scale: "0.24",
			walletCashUsdcAtStart: "25",
			status: "completed",
			completedAt: now,
			plan: {
				status: "no_feasible_position",
				blockReason: null,
				eligibleNetNavUsdc: 100,
				scale: 0.24,
				sleeveBudgetUsdc: 24,
				minimumFeasibleSleeveUsdc: null,
				intents: [],
				lockedOverweights: [],
				diagnostics: [
					{
						conditionId: CONDITION_B,
						tokenId: "historical-runtime-token",
						cohortId: "historical-cohort",
						reason: "no_gap",
						desiredShares: 1,
						heldShares: 1,
						openShares: 0,
						gapShares: 0,
						targetWeight: 1,
						limitPrice: 0.5,
						floorNotionalUsdc: 2.5,
						minimumSleeveUsdc: null,
					},
				],
			},
		});
		const [manyRun] = await db
			.insert(polyPositionGapRuns)
			.values({
				billingAccountId: ACCOUNT_MANY,
				createdByUserId: USER_MANY,
				targetId: MANY_RUNTIME_TARGET_ID,
				triggerReasons: ["timer"],
				targetSnapshotId: "bounded-runtime-book",
				targetSnapshotAsOf: now,
				targetSnapshotExpiresAt: future,
				targetSnapshot: { complete: true },
				plannerVersion: "position-gap-v3-bounded-test",
				budgetUsdc: "24",
				eligibleNetNavUsdc: "2000",
				scale: "0.012",
				walletCashUsdcAtStart: "25",
				status: "completed",
				completedAt: now,
				plan: {
					status: "no_feasible_position",
					blockReason: null,
					eligibleNetNavUsdc: 2000,
					scale: 0.012,
					sleeveBudgetUsdc: 24,
					minimumFeasibleSleeveUsdc: null,
					intents: [],
					lockedOverweights: [],
					diagnostics: Array.from({ length: 2000 }, (_, index) => ({
						conditionId: MANY_CONDITION,
						tokenId: `bounded-token-${index.toString().padStart(4, "0")}`,
						cohortId: `bounded-cohort-${index}`,
						reason: "no_gap",
						desiredShares: 1,
						heldShares: 1,
						openShares: 0,
						gapShares: 0,
						targetWeight: 0.0005,
						limitPrice: 0.5,
						floorNotionalUsdc: 2.5,
						minimumSleeveUsdc: null,
					})),
				},
			})
			.returning({ id: polyPositionGapRuns.id });
		manyRunId = manyRun?.id ?? "";
		if (!manyRunId) throw new Error("bounded runtime seed failed");
		await db.insert(polyTraderCurrentPositions).values([
			{
				traderWalletId: targetWalletId,
				conditionId: CONDITION_A,
				tokenId: "token-a",
				shares: "100",
				costBasisUsdc: "50",
				currentValueUsdc: "75",
				avgPrice: "0.5",
				contentHash: `a-${suffix}`,
				lastObservedAt: now,
				raw: { curPrice: "0.75", cashPnl: "25", outcome: "YES" },
			},
			{
				traderWalletId: targetWalletId,
				conditionId: CONDITION_B,
				tokenId: "token-b",
				shares: "50",
				costBasisUsdc: "30",
				currentValueUsdc: "25",
				avgPrice: "0.6",
				contentHash: `b-${suffix}`,
				lastObservedAt: now,
				raw: { curPrice: "0.5", cashPnl: "-5", outcome: "NO" },
			},
			{
				traderWalletId: partialWalletId,
				conditionId: CONDITION_A,
				tokenId: "partial-token",
				shares: "1",
				costBasisUsdc: "1",
				currentValueUsdc: "1",
				avgPrice: "1",
				contentHash: `partial-${suffix}`,
				lastObservedAt: now,
				raw: { curPrice: "1", cashPnl: "0", outcome: "YES" },
			},
			{
				traderWalletId: otherWalletId,
				conditionId: CONDITION_OTHER,
				tokenId: "other-token",
				shares: "999",
				costBasisUsdc: "999",
				currentValueUsdc: "999",
				avgPrice: "1",
				contentHash: `other-${suffix}`,
				lastObservedAt: now,
				raw: { curPrice: "1", cashPnl: "0", outcome: "YES" },
			},
		]);
	});

	afterAll(async () => {
		await db
			.delete(polyPositionGapRuns)
			.where(
				inArray(polyPositionGapRuns.billingAccountId, [
					ACCOUNT_A,
					ACCOUNT_MANY,
				]),
			);
		await db
			.delete(agentCapabilityGrants)
			.where(eq(agentCapabilityGrants.billingAccountId, ACCOUNT_A));
		await db
			.delete(polyTraderCurrentPositions)
			.where(
				inArray(polyTraderCurrentPositions.traderWalletId, [
					targetWalletId,
					partialWalletId,
					otherWalletId,
				]),
			);
		await db
			.delete(polyTraderIngestionCursors)
			.where(
				inArray(polyTraderIngestionCursors.traderWalletId, [
					targetWalletId,
					partialWalletId,
					otherWalletId,
				]),
			);
		await db
			.delete(polyMarketMetadata)
			.where(
				inArray(polyMarketMetadata.conditionId, [
					CONDITION_A,
					CONDITION_B,
					CONDITION_OTHER,
					CONDITION_RUNTIME,
				]),
			);
		await db
			.delete(polyTraderWallets)
			.where(
				inArray(polyTraderWallets.id, [
					targetWalletId,
					partialWalletId,
					otherWalletId,
				]),
			);
		await db
			.delete(polyCopyTradeTargets)
			.where(
				inArray(polyCopyTradeTargets.billingAccountId, [
					ACCOUNT_A,
					ACCOUNT_B,
					ACCOUNT_MANY,
				]),
			);
		await db
			.delete(billingAccounts)
			.where(
				inArray(billingAccounts.id, [
					ACCOUNT_A,
					ACCOUNT_B,
					ACCOUNT_EMPTY,
					ACCOUNT_MANY,
				]),
			);
		await db
			.delete(users)
			.where(inArray(users.id, [USER_A, USER_B, USER_EMPTY, USER_MANY]));
	});

	it("returns vendor facts, metadata, weight, and target completeness", async () => {
		const result = await getTargetPositionsForAccount(
			db as unknown as AgentGrantTransaction,
			ACCOUNT_A,
			{ sort: "portfolio_weight", limit: 25 },
		);

		expect(() =>
			PolyAccountTargetPositionsResponseSchema.parse(result),
		).not.toThrow();
		expect(result.live_position_rule).toEqual({
			active: true,
			shares_greater_than: 0,
			max_age_seconds: 21_600,
		});
		expect(result.positions).toHaveLength(4);
		expect(
			result.positions.some((row) => row.target_wallet === TARGET_OTHER),
		).toBe(false);
		expect(
			result.positions.find((row) => row.token_id === "token-a"),
		).toMatchObject({
			target_wallet: TARGET_A,
			market_title: "Will the target win?",
			outcome: "YES",
			portfolio_weight: 0.75,
			current_price: 0.75,
			cash_pnl_usdc: 25,
			row_source: "saved_and_runtime",
			runtime: {
				decision_reasons: ["no_gap"],
				target_weight: 0.75,
				desired_shares: 10,
				held_shares: 10,
			},
		});
		expect(
			result.positions.find((row) => row.token_id === "runtime-token"),
		).toMatchObject({
			market_title: "Runtime-only market",
			row_source: "runtime_only",
			shares: null,
			cost_basis_usdc: null,
			current_value_usdc: null,
			portfolio_weight: 0.25,
			runtime: {
				decision_reasons: ["below_market_floor"],
				target_weight: 0.25,
				desired_shares: 1.1,
				gap_shares: 1.1,
				market_floor_usdc: 4.25,
			},
		});
		expect(
			result.positions.find((row) => row.token_id === "token-a")?.market_url,
		).toBe("https://polymarket.com/event/target-event/will-the-target-win");
		expect(result.targets).toHaveLength(2);
		expect(
			result.targets.find((target) => target.target_wallet === TARGET_A),
		).toMatchObject({
			live_position_count: 2,
			live_portfolio_value_usdc: 100,
			observation: { completeness: "complete", freshness: "fresh" },
			position_gap_runtime: {
				status: "observed",
				position_count: 2,
			},
		});
		expect(
			result.targets.find((target) => target.target_wallet === TARGET_PARTIAL),
		).toMatchObject({
			observation: { completeness: "partial" },
			position_gap_runtime: { status: "not_applicable" },
		});
		expect(
			result.positions.some(
				(row) => row.token_id === "historical-runtime-token",
			),
		).toBe(false);
		expect(result.completeness).toMatchObject({
			complete: false,
			active_target_count: 2,
			complete_targets: 1,
			partial_targets: 1,
		});
	});

	it("returns identical runtime rows for the owner and an account-read delegate", async () => {
		const appDb = getAppDb();
		const readAs = (principalId: string) =>
			withTenantScope(appDb, userActor(toUserId(principalId)), (tx) =>
				getTargetPositionsForAccount(tx as AgentGrantTransaction, ACCOUNT_A, {
					sort: "portfolio_weight",
					limit: 25,
				}),
			);
		const [owner, delegate] = await Promise.all([
			readAs(USER_A),
			readAs(USER_B),
		]);
		expect(delegate.positions).toEqual(owner.positions);
		expect(delegate.next_cursor).toBe(owner.next_cursor);
		expect(delegate.truncated).toBe(owner.truncated);
		expect(delegate.completeness).toEqual(owner.completeness);
		expect(
			delegate.targets.map(({ observation, ...target }) => ({
				...target,
				observation: {
					...observation,
					staleness_seconds: 0,
				},
			})),
		).toEqual(
			owner.targets.map(({ observation, ...target }) => ({
				...target,
				observation: {
					...observation,
					staleness_seconds: 0,
				},
			})),
		);
	});

	it("marks an otherwise complete saved snapshot partial when it is stale", async () => {
		const staleAt = new Date(Date.now() - 20 * 60_000);
		await db
			.update(polyTraderIngestionCursors)
			.set({ lastSuccessAt: staleAt })
			.where(
				and(
					eq(polyTraderIngestionCursors.traderWalletId, targetWalletId),
					eq(
						polyTraderIngestionCursors.source,
						COPY_TARGET_POSITION_CURSOR_SOURCE,
					),
				),
			);
		const result = await getTargetPositionsForAccount(
			db as unknown as AgentGrantTransaction,
			ACCOUNT_A,
			{ sort: "portfolio_weight", limit: 25 },
		);
		expect(
			result.targets.find((target) => target.target_wallet === TARGET_A)
				?.observation,
		).toMatchObject({
			freshness: "stale",
			completeness: "partial",
			reason: "saved_snapshot_stale",
		});
		expect(result.completeness.complete).toBe(false);
		await db
			.update(polyTraderIngestionCursors)
			.set({ lastSuccessAt: now })
			.where(
				and(
					eq(polyTraderIngestionCursors.traderWalletId, targetWalletId),
					eq(
						polyTraderIngestionCursors.source,
						COPY_TARGET_POSITION_CURSOR_SOURCE,
					),
				),
			);
	});

	it("keeps a requested Position-gap target beyond the global cap exact and bounded", async () => {
		const query = {
			target_wallet: MANY_TARGET,
			sort: "portfolio_weight" as const,
			limit: 25,
		};
		const result = await getTargetPositionsForAccount(
			db as unknown as AgentGrantTransaction,
			ACCOUNT_MANY,
			query,
		);
		expect(result.targets).toHaveLength(1);
		expect(result.targets[0]).toMatchObject({
			target_wallet: MANY_TARGET,
			position_gap_runtime: {
				status: "observed",
				position_count: 2000,
			},
		});
		expect(result.positions).toHaveLength(25);
		expect(
			result.positions.every((row) => row.row_source === "runtime_only"),
		).toBe(true);
		expect(result.truncated).toBe(true);

		const appDb = getAppDb();
		await withTenantScope(appDb, userActor(toUserId(USER_MANY)), async (tx) => {
			const explained = await tx.execute(
				sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${targetPositionRowsSelect({
					accountId: ACCOUNT_MANY,
					query,
					cursor: null,
					limit: 25,
					runtimeTargets: [
						{
							wallet: MANY_TARGET,
							targetId: MANY_RUNTIME_TARGET_ID,
							runId: manyRunId,
						},
					],
				})}`,
			);
			const rows = Array.isArray(explained)
				? explained
				: ((explained as { rows?: unknown[] }).rows ?? []);
			const plan = ((
				rows[0] as { "QUERY PLAN": Array<Record<string, unknown>> }
			)["QUERY PLAN"]?.[0] ?? {}) as {
				Plan?: { "Actual Rows"?: number };
				"Execution Time"?: number;
			};
			expect(plan.Plan?.["Actual Rows"]).toBeLessThanOrEqual(26);
			expect(plan["Execution Time"]).toBeLessThan(1000);
		});
	}, 30_000);

	it("keyset-pages without crossing the tenant clamp", async () => {
		const first = await getTargetPositionsForAccount(
			db as unknown as AgentGrantTransaction,
			ACCOUNT_A,
			{ sort: "current_value", limit: 1 },
		);
		expect(first.positions).toHaveLength(1);
		expect(first.next_cursor).not.toBeNull();
		const second = await getTargetPositionsForAccount(
			db as unknown as AgentGrantTransaction,
			ACCOUNT_A,
			{
				sort: "current_value",
				limit: 1,
				cursor: first.next_cursor ?? undefined,
			},
		);
		expect(second.positions).toHaveLength(1);
		expect(second.positions[0]?.token_id).not.toBe(
			first.positions[0]?.token_id,
		);
		expect(second.positions[0]?.target_wallet).not.toBe(TARGET_OTHER);
	});

	it("rejects a cursor minted for another sort", () => {
		const cursor = encodeTargetPositionCursor({
			sort: "pnl",
			sortValue: "1",
			targetWallet: TARGET_A,
			conditionId: CONDITION_A,
			tokenId: "token-a",
		});
		expect(() => decodeTargetPositionCursor(cursor, "current_value")).toThrow(
			InvalidTargetPositionCursorError,
		);
	});

	it("returns a database-captured empty view when no targets are active", async () => {
		const result = await getTargetPositionsForAccount(
			db as unknown as AgentGrantTransaction,
			ACCOUNT_EMPTY,
			{ sort: "portfolio_weight", limit: 25 },
		);

		expect(result.targets).toEqual([]);
		expect(result.positions).toEqual([]);
		expect(result.completeness).toMatchObject({
			complete: true,
			active_target_count: 0,
		});
		expect(new Date(result.captured_at).getTime()).not.toBeNaN();
	});
});
