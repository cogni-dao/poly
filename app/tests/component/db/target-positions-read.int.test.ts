// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real-Postgres proof for the bounded, tenant-clamped target-position view. */

import { randomUUID } from "node:crypto";
import {
	polyMarketMetadata,
	polyTraderCurrentPositions,
	polyTraderIngestionCursors,
	polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { PolyAccountTargetPositionsResponseSchema } from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentGrantTransaction } from "@/features/agent-grants/authorization";
import {
	decodeTargetPositionCursor,
	encodeTargetPositionCursor,
	getTargetPositionsForAccount,
	InvalidTargetPositionCursorError,
} from "@/features/wallet-analysis/server/target-positions-read";
import {
	billingAccounts,
	polyCopyTradeTargets,
	users,
} from "@/shared/db/schema";

const suffix = randomUUID().replaceAll("-", "");
const USER_A = `target-positions-user-a-${suffix}`;
const USER_B = `target-positions-user-b-${suffix}`;
const USER_EMPTY = `target-positions-user-empty-${suffix}`;
const ACCOUNT_A = randomUUID();
const ACCOUNT_B = randomUUID();
const ACCOUNT_EMPTY = randomUUID();
const TARGET_A = `0x${suffix.slice(0, 40).padEnd(40, "a")}`;
const TARGET_PARTIAL = `0x${suffix.slice(0, 40).padEnd(40, "b")}`;
const TARGET_OTHER = `0x${suffix.slice(0, 40).padEnd(40, "c")}`;
const CONDITION_A = `0x${suffix}${"1".repeat(32)}`;
const CONDITION_B = `0x${suffix}${"2".repeat(32)}`;
const CONDITION_OTHER = `0x${suffix}${"3".repeat(32)}`;

describe("target positions saved-facts read", () => {
	const db = getSeedDb();
	let targetWalletId = "";
	let partialWalletId = "";
	let otherWalletId = "";

	beforeAll(async () => {
		await db.insert(users).values([
			{ id: USER_A, name: USER_A, walletAddress: TARGET_A },
			{ id: USER_B, name: USER_B, walletAddress: TARGET_OTHER },
			{ id: USER_EMPTY, name: USER_EMPTY },
		]);
		await db.insert(billingAccounts).values([
			{ id: ACCOUNT_A, ownerUserId: USER_A, balanceCredits: 0n },
			{ id: ACCOUNT_B, ownerUserId: USER_B, balanceCredits: 0n },
			{ id: ACCOUNT_EMPTY, ownerUserId: USER_EMPTY, balanceCredits: 0n },
		]);
		await db.insert(polyCopyTradeTargets).values([
			{
				billingAccountId: ACCOUNT_A,
				createdByUserId: USER_A,
				targetWallet: TARGET_A,
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

		const now = new Date();
		await db.insert(polyTraderIngestionCursors).values([
			{
				traderWalletId: targetWalletId,
				source: "data-api-positions",
				status: "ok",
				lastSuccessAt: now,
			},
			{
				traderWalletId: partialWalletId,
				source: "data-api-positions",
				status: "partial",
				lastSuccessAt: now,
			},
			{
				traderWalletId: otherWalletId,
				source: "data-api-positions",
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
		]);
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
				inArray(polyCopyTradeTargets.billingAccountId, [ACCOUNT_A, ACCOUNT_B]),
			);
		await db
			.delete(billingAccounts)
			.where(
				inArray(billingAccounts.id, [ACCOUNT_A, ACCOUNT_B, ACCOUNT_EMPTY]),
			);
		await db
			.delete(users)
			.where(inArray(users.id, [USER_A, USER_B, USER_EMPTY]));
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
		expect(result.positions).toHaveLength(3);
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
		});
		expect(
			result.targets.find((target) => target.target_wallet === TARGET_PARTIAL)
				?.observation.completeness,
		).toBe("partial");
		expect(result.completeness).toMatchObject({
			complete: false,
			active_target_count: 2,
			complete_targets: 1,
			partial_targets: 1,
		});
	});

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
