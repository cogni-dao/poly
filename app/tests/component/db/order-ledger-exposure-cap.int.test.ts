// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real Postgres proof of reservation parity, atomicity and recovery. bug.5042. */
import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";
import { ledgerCountedIntentUsdc } from "@/features/trading/ledger-lifecycle";
import { createOrderLedger } from "@/features/trading/order-ledger";
import {
	type InsertPendingInput,
	type LedgerRow,
	PositionCapReachedError,
} from "@/features/trading/order-ledger.types";
import { billingAccounts, polyCopyTradeFills, users } from "@/shared/db/schema";

const observed = new Date("2026-10-01T00:00:00Z");
const deny = {
	source: "executor_authorize_denied" as const,
	reason: "authorize_denied",
	observed_at: observed.toISOString(),
};
const final = (orderId: string, cost: number) => ({
	source: "venue_get_order" as const,
	order_id: orderId,
	status: "canceled" as const,
	filled_size_usdc: cost,
	observed_at: observed.toISOString(),
	fill_evidence:
		cost === 0
			? ("explicit_zero_size_matched" as const)
			: ("clob_associated_trades" as const),
});
async function harness(mode: "live" | "paper" = "live") {
	const db = getSeedDb();
	const userId = randomUUID();
	const account = randomUUID();
	const market = randomUUID();
	await db.insert(users).values({
		id: userId,
		walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
	});
	await db
		.insert(billingAccounts)
		.values({ id: account, ownerUserId: userId, balanceCredits: 0n });
	const ledger = createOrderLedger({
		db: db as unknown as PostgresJsDatabase<Record<string, unknown>>,
		appDb: getAppDb() as unknown as PostgresJsDatabase<Record<string, unknown>>,
		logger: pino({ enabled: false }),
		resolveExecutionMode: async () => mode,
	});
	const tenant = ledger.forTenant({
		billing_account_id: account,
		created_by_user_id: userId,
	});
	const intent = (
		size = 1,
		token = "token",
		target = randomUUID(),
	): InsertPendingInput => ({
		billing_account_id: account,
		created_by_user_id: userId,
		target_id: target,
		fill_id: randomUUID(),
		observed_at: observed,
		max_market_intent_usdc: 5,
		intent: {
			provider: "polymarket",
			market_id: market,
			outcome: "YES",
			side: "BUY",
			size_usdc: size,
			limit_price: 0.5,
			client_order_id: randomUUID(),
			attributes: { token_id: token, placement: "limit" },
		},
	});
	async function seed(
		status: string,
		attributes: Record<string, unknown> = {},
		orderId: string | null = null,
		lifecycle: string | null = null,
	) {
		const id = randomUUID();
		await db.insert(polyCopyTradeFills).values({
			billingAccountId: account,
			createdByUserId: userId,
			targetId: randomUUID(),
			fillId: randomUUID(),
			marketId: market,
			observedAt: observed,
			clientOrderId: id,
			orderId,
			status,
			positionLifecycle: lifecycle,
      mode,
			attributes: {
				size_usdc: 4,
				token_id: "token",
				placement: "limit",
				...attributes,
			},
			createdAt: observed,
			updatedAt: observed,
		});
		return id;
	}
	return { db, account, market, ledger, tenant, intent, seed };
}

describe("order exposure reservation (real PostgreSQL)", () => {
	it.each([
		["accepted error", "error", {}, "accepted-order", null, 4],
		["ambiguous no-ID error", "error", {}, null, null, 4],
		["definite denial", "error", { non_execution_proof: deny }, null, null, 0],
		[
			"contradictory known order wins",
			"error",
			{ non_execution_proof: deny },
			"accepted-order",
			null,
			4,
		],
		[
			"partial keeps full intent",
			"partial",
			{ filled_size_usdc: 1 },
			"partial-order",
			null,
			4,
		],
		[
			"unproven canceled fill",
			"canceled",
			{ filled_size_usdc: 1 },
			"cancel-order",
			null,
			4,
		],
		[
			"unproven canceled zero",
			"canceled",
			{ filled_size_usdc: 0 },
			"cancel-order",
			null,
			4,
		],
		[
			"proven final cancel",
			"canceled",
			{
				filled_size_usdc: 1,
				final_order_observation: final("cancel-order", 1),
			},
			"cancel-order",
			null,
			1,
		],
		[
			"proven zero",
			"canceled",
			{ final_order_observation: final("cancel-order", 0) },
			"cancel-order",
			null,
			0,
		],
		[
			"zero cannot erase positive fill",
			"canceled",
			{
				filled_size_usdc: 2,
				final_order_observation: final("cancel-order", 0),
			},
			"cancel-order",
			null,
			2,
		],
		[
			"wrong order proof",
			"canceled",
			{ final_order_observation: final("other", 0) },
			"cancel-order",
			null,
			4,
		],
		[
			"legacy closed timestamp is not authority",
			"error",
			{ closed_at: observed.toISOString() },
			null,
			null,
			4,
		],
		[
			"unredeemed winner remains reserved",
			"filled",
			{},
			"winner-order",
			"winner",
			4,
		],
		["resolving remains reserved", "filled", {}, "resolving-order", "resolving", 4],
    ["redemption pending remains reserved", "filled", {}, "redeem-pending-order", "redeem_pending", 4],
    ["terminal lifecycle", "filled", {}, "filled-order", "redeemed", 0],
	] as const)(
		"%s: planning and atomic guards agree",
		async (_, status, attrs, orderId, lifecycle, amount) => {
			const h = await harness();
			// Order IDs are globally unique; keep proof/row identities exact per fixture.
			const uniqueOrder = orderId ? `${orderId}-${h.account}` : null;
			const uniqueAttrs: Record<string, unknown> = { ...attrs };
			const proof = uniqueAttrs.final_order_observation as
				| Record<string, unknown>
				| undefined;
			if (proof && proof.order_id === orderId)
				uniqueAttrs.final_order_observation = {
					...proof,
					order_id: uniqueOrder,
				};
			await h.seed(status, uniqueAttrs, uniqueOrder, lifecycle);
			expect(
				await h.tenant.cumulativeIntentForMarketToken(h.market, "token"),
			).toBe(amount);
			const [row] = await h.ledger.listRecent({
				billing_account_id: h.account,
			});
			expect(ledgerCountedIntentUsdc(row as LedgerRow)).toBe(amount);
			const input = h.intent(1);
			input.max_market_intent_usdc = amount;
			await expect(h.ledger.insertPending(input)).rejects.toMatchObject({
				current_intent_usdc: amount,
				proposed_intent_usdc: 1,
				max_intent_usdc: amount,
			});
		},
	);

	it("serializes concurrent distinct target inserts and isolates account/token budgets", async () => {
		const h = await harness();
		await h.seed("error", {}, `known-${h.account}`);
		const results = await Promise.allSettled([
			h.ledger.insertPending(h.intent()),
			h.ledger.insertPending(h.intent()),
		]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const failure = results.find((r) => r.status === "rejected");
		expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(
			PositionCapReachedError,
		);
		expect(
			await h.tenant.cumulativeIntentForMarketToken(h.market, "token"),
		).toBe(5);
		await expect(
			h.ledger.insertPending(h.intent(1, "other-token")),
		).resolves.toBeUndefined();
		const other = await harness();
		const otherInput = other.intent();
		otherInput.intent.market_id = h.market;
		await expect(
			other.ledger.insertPending(otherInput),
		).resolves.toBeUndefined();
		expect(
			await other.tenant.cumulativeIntentForMarketToken(h.market, "token"),
		).toBe(1);
	});

  it("keeps live and paper dispatch within each account's own reservation", async () => {
    const live = await harness("live"); const paper = await harness("paper");
    await live.seed("error", {}, `live-${live.account}`);
    const paperInput = paper.intent(); paperInput.intent.market_id = live.market;
    await expect(paper.ledger.insertPending(paperInput)).resolves.toBeUndefined();
    const [stored] = await paper.db.select().from(polyCopyTradeFills).where(eq(polyCopyTradeFills.clientOrderId, paperInput.intent.client_order_id));
    expect(stored?.mode).toBe("paper");
    expect(await live.tenant.cumulativeIntentForMarketToken(live.market, "token")).toBe(4);
    expect(await paper.tenant.cumulativeIntentForMarketToken(live.market, "token")).toBe(1);
  });

	it.each(["not-a-number", -2, null, "NaN", "Infinity"])(
		"fails both paths closed for malformed intent %s",
		async (size) => {
			const h = await harness();
			await h.seed("error", { size_usdc: size });
			expect(
				await h.tenant.cumulativeIntentForMarketToken(h.market, "token"),
			).toBe(Infinity);
			await expect(h.ledger.insertPending(h.intent())).rejects.toThrow();
		},
	);

	it("preserves accepted receipts through both error/receipt orderings and zero observations", async () => {
		const h = await harness();
		for (const errorFirst of [false, true]) {
			const id = await h.seed("pending");
			const order = `venue-${id}`;
			const receipt = {
				order_id: order,
				client_order_id: id,
				status: "partial" as const,
				filled_size_usdc: 1,
				fill_price: 0.5,
				total_shares: 2,
				submitted_at: observed.toISOString(),
				attributes: { realizedFillSource: "clob_associated_trades" },
			};
			if (errorFirst)
				await h.ledger.markError({
					client_order_id: id,
					error: "secondary audit failed",
				});
			await h.ledger.markOrderId({ client_order_id: id, receipt });
			await h.ledger.markError({
				client_order_id: id,
				error: "secondary audit failed",
				non_execution_proof: deny,
			});
			await h.ledger.updateStatus({
				client_order_id: id,
				order_id: order,
				status: "canceled",
				filled_size_usdc: 0,
				final_order_observation: final(order, 0),
			});
			const [row] = await h.db
				.select()
				.from(polyCopyTradeFills)
				.where(eq(polyCopyTradeFills.clientOrderId, id));
			expect(row?.orderId).toBe(order);
			expect(row?.status).toBe("canceled");
			expect(Number(row?.shares)).toBe(2);
			expect(row?.attributes?.filled_size_usdc).toBe(1);
		}
		expect(
			await h.tenant.cumulativeIntentForMarketToken(h.market, "token"),
		).toBe(2);
	});

	it("positive legacy shares with missing cumulative cost conflict with zero-fill proof", async () => {
		const h = await harness();
		const order = `legacy-${h.account}`;
		const id = await h.seed(
			"canceled",
			{ filled_size_usdc: 0, final_order_observation: final(order, 0) },
			order,
		);
		await h.db
			.update(polyCopyTradeFills)
			.set({ shares: "2", price: "0.5" })
			.where(eq(polyCopyTradeFills.clientOrderId, id));
		expect(
			await h.tenant.cumulativeIntentForMarketToken(h.market, "token"),
		).toBe(4);
		const [mapped] = await h.ledger.listRecent({
			billing_account_id: h.account,
		});
		expect(mapped?.executed_shares).toBe(2);
		expect(mapped && ledgerCountedIntentUsdc(mapped)).toBe(4);
		await expect(h.ledger.insertPending(h.intent(2))).rejects.toMatchObject({
			current_intent_usdc: 4,
		});
		const recovery = await h.ledger.listOpenOrPending({
			olderThanMs: 0,
			limit: 10000,
		});
		expect(recovery.some((r) => r.client_order_id === id)).toBe(true);
	});

	it("rotates 200 ambiguous no-ID rows ahead of the next eligible recovery row", async () => {
		const h = await harness();
		const ids = [];
		for (let n = 0; n < 201; n++) ids.push(await h.seed("error"));
		// Cross-tenant scheduler may include other tests' rows. Pin this test's own
		// rows ahead of every regular fixture, then exercise the real selector.
		await h.db
			.update(polyCopyTradeFills)
			.set({
				createdAt: new Date("2000-01-01"),
				updatedAt: new Date("2000-01-01"),
			})
			.where(sql`${polyCopyTradeFills.billingAccountId} = ${h.account}`);
		const first = await h.ledger.listOpenOrPending({ limit: 200 });
		expect(first).toHaveLength(200);
		await h.ledger.markReconcileAttempted(first.map((r) => r.client_order_id));
		const second = await h.ledger.listOpenOrPending({ limit: 200 });
		expect(
			second.some(
				(r) =>
					ids.includes(r.client_order_id) &&
					!first.some((x) => x.client_order_id === r.client_order_id),
			),
		).toBe(true);
		const changed = await h.db
			.select()
			.from(polyCopyTradeFills)
			.where(
				eq(
					polyCopyTradeFills.clientOrderId,
					first[0]?.client_order_id ?? "missing",
				),
			);
		expect(changed[0]?.status).toBe("error");
		expect(changed[0]?.syncedAt).toBeNull();
	});
});
