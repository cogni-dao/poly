// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Purpose: Prove the local live canary's correlation evidence is tenant
 * isolated and its insert-before-place idempotency survives a process restart.
 * Scope: Real testcontainers Postgres with app/service roles; no CLOB calls.
 * Invariants: A tenant reads only its own canary evidence, missing tenant scope
 * reads nothing, and replaying the same durable fill key inserts no second row.
 */

import { randomUUID } from "node:crypto";
import {
	polyCopyTradeDecisions,
	polyCopyTradeFills,
} from "@cogni/db-schema/copy-trade";
import { toUserId, userActor } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { billingAccounts, users } from "@/shared/db/schema";

const TARGET_ID = randomUUID();
const USER_A = randomUUID();
const USER_B = randomUUID();
const ACCOUNT_A = randomUUID();
const ACCOUNT_B = randomUUID();
const FILL_A = "local-canary:v1:fixed-input-a";
const FILL_B = "local-canary:v1:fixed-input-b";
const CORRELATION_A = randomUUID();
const CORRELATION_B = randomUUID();

function wallet(seed: string): string {
	return `0x${seed.repeat(40)}`;
}

describe("local live proof DB isolation and restart idempotency", () => {
	beforeAll(async () => {
		const db = getSeedDb();
		await db.insert(users).values([
			{ id: USER_A, name: "Local proof A", walletAddress: wallet("a") },
			{ id: USER_B, name: "Local proof B", walletAddress: wallet("b") },
		]);
		await db.insert(billingAccounts).values([
			{ id: ACCOUNT_A, ownerUserId: USER_A, balanceCredits: 0n },
			{ id: ACCOUNT_B, ownerUserId: USER_B, balanceCredits: 0n },
		]);
		await db.insert(polyCopyTradeFills).values([
			{
				billingAccountId: ACCOUNT_A,
				createdByUserId: USER_A,
				targetId: TARGET_ID,
				fillId: FILL_A,
				marketId: "local-proof-market-a",
				observedAt: new Date("2026-10-09T00:00:00.000Z"),
				clientOrderId: "0xlocal-proof-client-a",
				orderId: "local-proof-order-a",
				status: "open",
				mode: "live",
				attributes: {
					correlation_id: CORRELATION_A,
					algorithm_version: "local-canary-v1",
					size_usdc: 1,
				},
			},
			{
				billingAccountId: ACCOUNT_B,
				createdByUserId: USER_B,
				targetId: TARGET_ID,
				fillId: FILL_B,
				marketId: "local-proof-market-b",
				observedAt: new Date("2026-10-09T00:00:01.000Z"),
				clientOrderId: "0xlocal-proof-client-b",
				orderId: "local-proof-order-b",
				status: "open",
				mode: "live",
				attributes: {
					correlation_id: CORRELATION_B,
					algorithm_version: "local-canary-v1",
					size_usdc: 1,
				},
			},
		]);
		await db.insert(polyCopyTradeDecisions).values([
			{
				billingAccountId: ACCOUNT_A,
				createdByUserId: USER_A,
				targetId: TARGET_ID,
				fillId: FILL_A,
				outcome: "placed",
				intent: {
					correlation_id: CORRELATION_A,
					algorithm_version: "local-canary-v1",
					client_order_id: "0xlocal-proof-client-a",
					mirror_usdc: 1,
				},
				receipt: { order_id: "local-proof-order-a", status: "open" },
				decidedAt: new Date("2026-10-09T00:00:00.100Z"),
				mode: "live",
			},
			{
				billingAccountId: ACCOUNT_B,
				createdByUserId: USER_B,
				targetId: TARGET_ID,
				fillId: FILL_B,
				outcome: "placed",
				intent: {
					correlation_id: CORRELATION_B,
					algorithm_version: "local-canary-v1",
					client_order_id: "0xlocal-proof-client-b",
					mirror_usdc: 1,
				},
				receipt: { order_id: "local-proof-order-b", status: "open" },
				decidedAt: new Date("2026-10-09T00:00:01.100Z"),
				mode: "live",
			},
		]);
	});

	afterAll(async () => {
		const db = getSeedDb();
		await db
			.delete(polyCopyTradeDecisions)
			.where(inArray(polyCopyTradeDecisions.fillId, [FILL_A, FILL_B]));
		await db
			.delete(polyCopyTradeFills)
			.where(inArray(polyCopyTradeFills.fillId, [FILL_A, FILL_B]));
		await db
			.delete(billingAccounts)
			.where(inArray(billingAccounts.id, [ACCOUNT_A, ACCOUNT_B]));
		await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
	});

	it("returns one fully correlated evidence chain per tenant", async () => {
		const appDb = getAppDb();
		const readFor = async (userId: string) =>
			withTenantScope(appDb, userActor(toUserId(userId)), async (tx) => ({
				fills: await tx
					.select()
					.from(polyCopyTradeFills)
					.where(inArray(polyCopyTradeFills.fillId, [FILL_A, FILL_B])),
				decisions: await tx
					.select()
					.from(polyCopyTradeDecisions)
					.where(inArray(polyCopyTradeDecisions.fillId, [FILL_A, FILL_B])),
			}));

		const a = await readFor(USER_A);
		const b = await readFor(USER_B);
		expect(a.fills.map((row) => row.billingAccountId)).toEqual([ACCOUNT_A]);
		expect(a.decisions.map((row) => row.billingAccountId)).toEqual([ACCOUNT_A]);
		expect(b.fills.map((row) => row.billingAccountId)).toEqual([ACCOUNT_B]);
		expect(b.decisions.map((row) => row.billingAccountId)).toEqual([ACCOUNT_B]);

		const fillAttributes = a.fills[0]?.attributes;
		const intent = a.decisions[0]?.intent;
		const receipt = a.decisions[0]?.receipt;
		expect(fillAttributes?.correlation_id).toBe(CORRELATION_A);
		expect(intent?.correlation_id).toBe(CORRELATION_A);
		expect(intent?.algorithm_version).toBe("local-canary-v1");
		expect(intent?.client_order_id).toBe(a.fills[0]?.clientOrderId);
		expect(intent?.mirror_usdc).toBe(1);
		expect(receipt?.order_id).toBe(a.fills[0]?.orderId);
	});

	it("returns no canary evidence without tenant context", async () => {
		const rows = await getAppDb().transaction((tx) =>
			tx
				.select()
				.from(polyCopyTradeFills)
				.where(inArray(polyCopyTradeFills.fillId, [FILL_A, FILL_B])),
		);
		expect(rows).toEqual([]);
	});

	it("deduplicates the same durable fill after a simulated process restart", async () => {
		const dbAfterRestart = getSeedDb();
		await dbAfterRestart
			.insert(polyCopyTradeFills)
			.values({
				billingAccountId: ACCOUNT_A,
				createdByUserId: USER_A,
				targetId: TARGET_ID,
				fillId: FILL_A,
				marketId: "local-proof-market-a",
				observedAt: new Date("2026-10-09T00:05:00.000Z"),
				clientOrderId: "0xshould-not-insert",
				status: "pending",
				mode: "live",
				attributes: { correlation_id: "should-not-insert" },
			})
			.onConflictDoNothing();

		const rows = await dbAfterRestart
			.select()
			.from(polyCopyTradeFills)
			.where(eq(polyCopyTradeFills.fillId, FILL_A));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.clientOrderId).toBe("0xlocal-proof-client-a");
		expect(rows[0]?.attributes?.correlation_id).toBe(CORRELATION_A);
	});
});
