// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real Postgres proof of reservation parity, atomicity and recovery. bug.5042. */
import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { noopMetrics, type OrderReceipt } from "@cogni/poly-market-provider";
import { buildMirrorTargetConfig } from "@/bootstrap/jobs/copy-trade-mirror.job";
import { runMirrorTick } from "@/features/copy-trade/mirror-pipeline";
import { createPolyTradeExecutorFactory } from "@/bootstrap/capabilities/poly-trade-executor";
import { createExecutionVenueResolver, createPaperVenue, derivePaperAccountAddress } from "@/features/paper-accounts";
import { getAppDb } from "@/adapters/server/db/client";
import { ledgerCountedIntentUsdc } from "@/features/trading/ledger-lifecycle";
import { createOrderLedger } from "@/features/trading/order-ledger";
import {
	type InsertPendingInput,
	type LedgerRow,
	PositionCapReachedError,
} from "@/features/trading/order-ledger.types";
import { billingAccounts, polyCopyTradeFills, polyWalletConnections, polyWalletGrants, users } from "@/shared/db/schema";

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
async function harness(mode: "live" | "paper" = "live", trustedPaper = false) {
	const db = getSeedDb();
	const userId = randomUUID();
	const account = randomUUID();
	const market = trustedPaper ? `0x${randomUUID().replaceAll("-", "").repeat(2)}` : randomUUID();
  const defaultToken = trustedPaper ? "12345678901234567890" : "token";
	await db.insert(users).values({
		id: userId,
		walletAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
	});
	await db
		.insert(billingAccounts)
		.values({ id: account, ownerUserId: userId, balanceCredits: 0n });
  const connectionId = randomUUID();
  if (trustedPaper) {
    const address = derivePaperAccountAddress(account);
    await db.insert(polyWalletConnections).values({ id: connectionId, billingAccountId: account,
      createdByUserId: userId, kind: "paper", address, funderAddress: address, paperSeedUsdc: "100",
      custodialConsentAcceptedAt: observed, custodialConsentActorKind: "user", custodialConsentActorId: userId,
      tradingApprovalsReadyAt: observed });
    await db.insert(polyWalletGrants).values({ billingAccountId: account, walletConnectionId: connectionId,
      createdByUserId: userId, scopes: ["poly:trade:buy"], perOrderUsdcCap: "10", dailyUsdcCap: "1000", hourlyFillsCap: 1000 });
  }
  const authenticatedReceipt = async (native: OrderReceipt) => {
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      const url = new URL(String(input));
      expect(url.origin).toBe("http://paper.exposure.test");
      expect(url.searchParams.get("account_id")).toBe(connectionId);
      expect(url.pathname).toBe(`/orders/${native.order_id}`);
      return Response.json(native);
    });
    try {
      const factory = createPolyTradeExecutorFactory({ logger: pino({ enabled: false }), metrics: noopMetrics,
        paperSidecarUrl: "http://paper.exposure.test", paperVenue: createPaperVenue({ db }),
        resolveExecutionVenue: createExecutionVenueResolver({ db }) });
      const executor = await factory.getPolyTradeExecutorFor(account);
      const result = await executor.getOrder(native.order_id);
      if (!("found" in result)) throw new Error("authenticated paper exposure receipt absent");
      return result.found;
    } finally { transport.mockRestore(); }
  };
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
		token = defaultToken,
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
				token_id: defaultToken,
        ...(trustedPaper ? { condition_id: market, side: "BUY" } : {}),
				placement: "limit",
				...attributes,
			},
			createdAt: observed,
			updatedAt: observed,
		});
		return id;
	}
	return { db, userId, account, market, token: defaultToken, ledger, tenant, intent, seed, authenticatedReceipt };
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
			expect(
				await h.ledger.cumulativeIntentForMarketToken(
					h.account,
					h.market,
					"token",
				),
			).toBe(Infinity);
			await expect(h.ledger.insertPending(h.intent())).rejects.toThrow();
			await expect(h.tenant.insertPending(h.intent())).rejects.toThrow();
			// The failed tenant transaction has rolled back; a subsequent read works
			// and neither atomic path inserted an order eligible for dispatch.
			expect(
				await h.ledger.listRecent({ billing_account_id: h.account }),
			).toHaveLength(1);
		},
	);

	it.each([
    ["live", "clob_associated_trades", true, 8, 10, 0.8],
    ["live", "estimated", true, 6, 12, 0.5],
    ["live", "data_api_activity_position", true, 6, 12, 0.5],
    ["paper", undefined, true, 8, 10, 0.8],
    ["paper", "paper_order_receipt", true, 8, 10, 0.8],
    ["paper", "estimated", true, 6, 12, 0.5],
    ["paper", "data_api_activity_position", true, 6, 12, 0.5],
    ["paper", undefined, false, 6, 12, 0.5],
	] as const)(
		"canceled recovery preserves %s source=%s receiptStamp=%s cost=%s",
		async (mode, source, receiptStamp, cost, shares, price) => {
      const h = await harness(mode, mode === "paper");
			const order = `cost-floor-${h.account}`;
			const id = await h.seed(
				"partial",
				{
					size_usdc: 8,
					filled_size_usdc: 8,
					...(source ? { realized_fill_source: source } : {}),
          ...(receiptStamp ? { submitted_at: observed.toISOString() } : {}),
				},
				order,
			);
			await h.db
				.update(polyCopyTradeFills)
				.set({ shares: "10", price: "0.8" })
				.where(eq(polyCopyTradeFills.clientOrderId, id));
			// Each observation is internally coherent, but 12 * .5 = 6 cannot
			// replace an already verified cumulative spend of 10 * .8 = 8.
			await h.ledger.updateStatus({
				client_order_id: id,
				order_id: order,
				status: "canceled",
				total_shares: 12,
				fill_price: 0.5,
				filled_size_usdc: 6,
        ...(mode === "paper" ? { paper_receipt: await h.authenticatedReceipt({ order_id: order,
          client_order_id: id, status: "canceled", filled_size_usdc: 6, total_shares: 12, fill_price: 0.5,
          fees_usdc: 0, submitted_at: observed.toISOString(), attributes: { market: h.market, tokenId: h.token,
            side: "BUY", sizeMatched: 12 } }) } : {}),
				realized_fill_source: mode === "paper" ? "paper_order_receipt" : "clob_associated_trades",
        final_order_observation: {
          ...final(order, 6),
          fill_evidence: mode === "paper" ? "paper_order_receipt" : "clob_associated_trades",
        },
			});
			const [stored] = await h.db
				.select()
				.from(polyCopyTradeFills)
				.where(eq(polyCopyTradeFills.clientOrderId, id));
			expect(stored?.attributes?.filled_size_usdc).toBe(cost);
			expect(Number(stored?.shares)).toBe(shares);
			expect(Number(stored?.price)).toBe(price);
			if (cost === 8) {
				expect(stored?.attributes?.final_order_observation).toBeUndefined();
				const recovery = await h.ledger.listOpenOrPending({
					olderThanMs: 0,
					limit: 10000,
				});
				expect(recovery.some((r) => r.client_order_id === id)).toBe(true);
			} else {
				expect(stored?.attributes?.final_order_observation).toMatchObject({
					filled_size_usdc: 6,
				});
			}
			expect(
				await h.tenant.cumulativeIntentForMarketToken(h.market, h.token),
			).toBe(cost);
			expect(
				await h.ledger.cumulativeIntentForMarketToken(
					h.account,
					h.market,
					h.token,
				),
			).toBe(cost);
			const [mapped] = await h.ledger.listRecent({
				billing_account_id: h.account,
			});
			expect(mapped && ledgerCountedIntentUsdc(mapped)).toBe(cost);
			for (const insert of [h.ledger.insertPending, h.tenant.insertPending]) {
				const input = h.intent(2);
				input.max_market_intent_usdc = cost;
				await expect(insert(input)).rejects.toMatchObject({
					current_intent_usdc: cost,
					proposed_intent_usdc: input.intent.size_usdc,
					max_intent_usdc: cost,
				});
			}
		},
	);

  it("stamps direct paper receipt provenance without treating a paper intent as execution", async () => {
    const h = await harness("paper", true);
    const id = await h.seed("pending");
    await h.ledger.markOrderId({
      client_order_id: id,
      receipt: {
        order_id: "paper-order",
        client_order_id: id,
        status: "partial",
        filled_size_usdc: 8,
        total_shares: 10,
        fill_price: 0.8,
        submitted_at: observed.toISOString(),
        attributes: { sizeMatched: 10 },
      },
    });
    const [unbound] = await h.db.select().from(polyCopyTradeFills).where(eq(polyCopyTradeFills.clientOrderId, id));
    expect(unbound?.attributes?.realized_fill_source).toBeUndefined();
    expect(Number(unbound?.shares ?? 0)).toBe(0);
    const trusted = await h.authenticatedReceipt({ order_id: "paper-order", client_order_id: id, status: "partial",
      filled_size_usdc: 8, total_shares: 10, fill_price: 0.8, submitted_at: observed.toISOString(),
      attributes: { market: h.market, tokenId: h.token, side: "BUY", sizeMatched: 10 } });
    await h.ledger.markOrderId({ client_order_id: id, receipt: trusted });
    const [stored] = await h.db.select().from(polyCopyTradeFills)
      .where(eq(polyCopyTradeFills.clientOrderId, id));
    expect(stored?.attributes?.realized_fill_source).toBe("paper_order_receipt");
    expect(stored?.attributes?.filled_size_usdc).toBe(8);
    expect(Number(stored?.shares)).toBe(10);
  });

	it.each([false, true])(
		"PAPER pipeline fallback keeps trusted receipt and durable acknowledgement, rejected=%s",
		async (rejected) => {
			const h = await harness("paper", true);
			const logs: Record<string, unknown>[] = [];
			const logger = pino(
				{ level: "trace" },
				{
					write(line: string) {
						logs.push(JSON.parse(line));
					},
				},
			);
			const target = buildMirrorTargetConfig({
				targetWallet: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
				billingAccountId: h.account,
				createdByUserId: h.userId,
				sizingPolicyKind: "min_bet",
			});
			target.sizing = { kind: "min_bet", max_usdc_per_condition: 1 };
			const fill = {
				target_wallet: target.target_wallet,
				fill_id: `chain:${randomUUID()}`,
				source: "chain" as const,
				market_id: h.market,
				outcome: "YES",
				side: "BUY" as const,
				price: 0.5,
				size_usdc: 1,
				observed_at: observed.toISOString(),
				attributes: {
					asset: h.token,
					condition_id: h.market,
					end_date: "2027-10-01T00:00:00Z",
				},
			};
			let receipt:
				| Awaited<ReturnType<typeof h.authenticatedReceipt>>
				| undefined;
			let primaryRolledBack = false;
			const mark = vi
				.spyOn(h.ledger, "markOrderId")
				.mockImplementationOnce(async (input) => {
					try {
						return await h.db.transaction(async (tx) => {
							const transactionalLedger = createOrderLedger({
								db: tx as unknown as PostgresJsDatabase<
									Record<string, unknown>
								>,
								logger: pino({ enabled: false }),
								resolveExecutionMode: async () => "paper",
							});
							const accepted = await transactionalLedger.markOrderId(input);
							expect(accepted).toMatchObject({
								accepted: !rejected,
								client_order_id: input.client_order_id,
							});
							if (!rejected) {
								const [inside] = await tx
									.select()
									.from(polyCopyTradeFills)
									.where(
										eq(polyCopyTradeFills.clientOrderId, input.client_order_id),
									);
								expect(inside?.orderId).toBe(input.receipt.order_id);
								expect(inside?.attributes?.paper_receipt_v1).toBeDefined();
							}
							// An actual native transaction fault rolls back the primary write.
							await tx.execute(sql`select 1 / 0`);
							return accepted;
						});
					} catch (error) {
						expect(error).toMatchObject({ cause: { code: "22012" } });
						const [rolledBack] = await h.db
							.select()
							.from(polyCopyTradeFills)
							.where(
								eq(polyCopyTradeFills.clientOrderId, input.client_order_id),
							);
						expect(rolledBack?.status).toBe("pending");
						expect(rolledBack?.orderId).toBeNull();
						expect(rolledBack?.attributes?.paper_receipt_v1).toBeUndefined();
						primaryRolledBack = true;
						throw error;
					}
				});
			const fallback = vi.spyOn(h.ledger, "updateStatus");
			const markError = vi.spyOn(h.ledger, "markError");
			const placeIntent = vi.fn(async (intent: { client_order_id: string }) => {
				// INSERT_BEFORE_PLACE is verified against the actual database row.
				const [pending] = await h.db
					.select()
					.from(polyCopyTradeFills)
					.where(eq(polyCopyTradeFills.clientOrderId, intent.client_order_id));
				expect(pending?.status).toBe("pending");
				receipt = await h.authenticatedReceipt({
					order_id: `paper-fallback-${h.account}`,
					client_order_id: intent.client_order_id,
					status: "partial",
					filled_size_usdc: 1,
					fill_price: 0.5,
					total_shares: 2,
					fees_usdc: 0,
					submitted_at: observed.toISOString(),
					attributes: {
						market: h.market,
						tokenId: h.token,
						side: "BUY",
						sizeMatched: 2,
					},
				});
				// Negative crosses the trusted-context boundary, not a forged positive proof.
				if (rejected) receipt = { ...receipt, paper_context: undefined };
				return receipt;
			});
			await runMirrorTick({
				implementationRevision: "0123456789abcdef0123456789abcdef01234567",
				targetRowId: randomUUID(),
				assignmentId: `target:${observed.toISOString()}`,
				isAssignmentCurrent: async () => true,
				source: {
					fetchSince: async () => ({
						fills: [fill, { ...fill, fill_id: `chain:${randomUUID()}` }],
						newSince: 2,
					}),
				},
				ledger: h.ledger,
				target,
				placeIntent,
				getExecutionMode: async () => "paper",
				getCursor: () => undefined,
				setCursor: () => undefined,
				logger,
				metrics: noopMetrics,
				clock: () => new Date("2026-10-01T00:00:01Z"),
				getTargetConditionPosition: async () => ({
					condition_id: h.market,
					tokens: [
						{
							token_id: h.token,
							size_shares: 100,
							cost_usdc: 50,
							current_value_usdc: 50,
						},
					],
				}),
				getTargetPortfolioCurrentValue: async () => 100,
				getMirrorPortfolioSnapshot: async () => ({
					currentValueUsdc: 100,
					positions: [],
				}),
				getMarketConstraints: async () => ({
					minShares: 1,
					minUsdcNotional: 1,
					tickSize: 0.001,
				}),
			});
			expect(primaryRolledBack).toBe(true);
			expect(placeIntent).toHaveBeenCalledOnce();
			expect(mark).toHaveBeenCalledOnce();
			expect(fallback).toHaveBeenCalledOnce();
			expect(fallback.mock.calls[0]?.[0].paper_receipt).toBe(receipt);
			expect(await fallback.mock.results[0]?.value).toMatchObject({
				accepted: !rejected,
				mode: "paper",
			});
			expect(markError).not.toHaveBeenCalled();
			const [stored] = await h.db
				.select()
				.from(polyCopyTradeFills)
				.where(
					eq(
						polyCopyTradeFills.clientOrderId,
						receipt?.client_order_id ?? "missing",
					),
				);
			expect(stored?.status).toBe(rejected ? "pending" : "partial");
			expect(stored?.orderId).toBe(rejected ? null : receipt?.order_id);
			if (rejected) {
				expect(stored?.attributes?.paper_receipt_v1).toBeUndefined();
				expect(logs).toContainEqual(
					expect.objectContaining({ errorCode: "receipt_persistence_failed" }),
				);
			} else {
				expect(stored?.attributes?.paper_receipt_v1).toMatchObject({
					order_id: receipt?.order_id,
					client_order_id: receipt?.client_order_id,
					condition_id: h.market,
					token_id: h.token,
					shares: 2,
					notional_usdc: 1,
					fees_usdc: 0,
				});
				expect(Number(stored?.shares)).toBe(2);
				expect(stored?.attributes?.filled_size_usdc).toBe(1);
				expect(logs).not.toContainEqual(
					expect.objectContaining({ errorCode: "receipt_persistence_failed" }),
				);
			}
			expect(
				await h.tenant.cumulativeIntentForMarketToken(h.market, h.token),
			).toBe(1);
			expect(logs).toContainEqual(
				expect.objectContaining({
					outcome: "placed",
					order_id: receipt?.order_id,
				}),
			);
			expect(logs).toContainEqual(
				expect.objectContaining({
					outcome: "skipped",
					reason: "position_cap_reached",
				}),
			);
			expect(logs).not.toContainEqual(
				expect.objectContaining({ reason: "placement_failed" }),
			);
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
      expect(row?.attributes?.final_order_observation).toBeUndefined();
		}
    // Contradictory zero proof retains each full intent until coherent recovery.
		expect(
			await h.tenant.cumulativeIntentForMarketToken(h.market, "token"),
		).toBe(8);
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
