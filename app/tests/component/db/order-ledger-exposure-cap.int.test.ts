// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real Postgres proof of reservation parity, atomicity and recovery. bug.5042. */
import { randomUUID } from "node:crypto";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pino from "pino";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";
import { ledgerCountedIntentUsdc } from "@/features/trading/ledger-lifecycle";
import { createOrderLedger } from "@/features/trading/order-ledger";
import {
	type InsertPendingInput,
	type LedgerRow,
	PositionCapReachedError,
} from "@/features/trading/order-ledger.types";
import { billingAccounts, polyCopyTradeFills, users } from "@/shared/db/schema";

const qualificationExecutor = vi.hoisted(() => vi.fn());
vi.mock("@/bootstrap/container", () => ({ getContainer: () => ({
  log: pino({ enabled: false }), getBoundedPaperExecutor: qualificationExecutor,
}) }));

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
      const h = await harness(mode);
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
				await h.tenant.cumulativeIntentForMarketToken(h.market, "token"),
			).toBe(cost);
			expect(
				await h.ledger.cumulativeIntentForMarketToken(
					h.account,
					h.market,
					"token",
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
    const h = await harness("paper");
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
    const [stored] = await h.db.select().from(polyCopyTradeFills)
      .where(eq(polyCopyTradeFills.clientOrderId, id));
    expect(stored?.attributes?.realized_fill_source).toBe("paper_order_receipt");
    expect(stored?.attributes?.filled_size_usdc).toBe(8);
    expect(Number(stored?.shares)).toBe(10);
  });

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

// CI-only proof here: the session's local budget selects the qualification and proxy unit files.
describe("release qualification claim (real PostgreSQL)", () => {
  let resolveQualificationDependencies: typeof import("@/bootstrap/qualification").resolveQualificationDependencies;
  let qualifyRelease: typeof import("@/features/deploy-qualification/service").qualifyRelease;
  let qualificationOperationIds: typeof import("@/features/deploy-qualification/service").qualificationOperationIds;
  beforeAll(async () => {
    ({ resolveQualificationDependencies } = await import("@/bootstrap/qualification"));
    ({ qualifyRelease, qualificationOperationIds } = await import("@/features/deploy-qualification/service"));
  }, 30000);
  it("cancels before native receipt persistence blocks to the deadline; retains that failure and cannot redispatch", async () => {
    const h = await harness("paper"), input = h.intent();
    const controller = new AbortController();
    const deadlineAt = Date.now() + 2000;
    const native = resolveQualificationDependencies({ accountId: h.account, ownerId: input.created_by_user_id }, "http://127.0.0.1:9100", controller.signal, deadlineAt);
    const sha = "a".repeat(40), image = `ghcr.io/cogni-dao/poly@sha256:${"b".repeat(64)}`;
    const challenge = {
      iss: "cogni-operator" as const, aud: "cogni-release-qualification" as const,
      iat: Date.now()/1000, exp: Date.now()/1000+60, jti: "blocked-save",
      nodeId: "4b06359a-a859-4399-888e-a8c7a6696f7e", env: "candidate-a" as const,
      releaseId: randomUUID(), sourceSha: sha, bundleDigest: image,
      services: { app: image, "paper-trader": image }, attemptId: "attempt-a", allocation: "allocation-a",
      mode: "qualify" as const, helperBootId: null, companionBootIds: null,
      companionReadiness: { "paper-trader": { port: 9100, path: "/readyz" } },
    };
    const ids = qualificationOperationIds(h.account, challenge.releaseId);
    let release!: () => void, locked!: () => void, saving!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const saveEntered = new Promise<void>(resolve => { saving = resolve; });
    let blocker: Promise<unknown> | undefined;
    let persistenceFailure: unknown;
    let claimFailure: unknown;
    const bounded = async <T>(phase: string, promise: Promise<T>): Promise<T> => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${phase} timed out`)), 3000);
        })]);
      } finally { clearTimeout(timeout); }
    };
    const receipt = { order_id: `paper-${randomUUID()}`, client_order_id: ids.clientOrderId, status: "open" as const, filled_size_usdc: 0, submitted_at: new Date().toISOString() };
    const cancel = vi.fn(async () => { expect(controller.signal.aborted).toBe(false); });
    const place = vi.fn(async () => {
      blocker = h.db.transaction(async tx => {
        const rows = await tx.execute(sql`SELECT 1 FROM poly_copy_trade_fills WHERE billing_account_id=${h.account} AND target_id=${ids.targetId} AND fill_id=${ids.fillId} FOR UPDATE`);
        expect(rows).toHaveLength(1);
        locked();
        await held;
      });
      await bounded("row lock", Promise.race([acquired, blocker.then(() => { throw new Error("row lock ended early"); })]));
      return receipt;
    });
    qualificationExecutor.mockResolvedValue({ placeIntent: place, cancelOrder: cancel });
    const deps = {
      ...native,
      checkFixture: async () => {},
      helper: async (_signal: AbortSignal, readiness: { port: number; path: string }) => ({ buildSha: sha, bootId: "boot-a", ready: { ...readiness, status: 200 as const, observedAt: new Date().toISOString() } }),
      selectIntent: async () => ({ market_id: input.intent.market_id, outcome: "YES" }),
      claim: async (intent: typeof input.intent, operationIds: typeof ids, observedAt: Date) => {
        try { return await h.tenant.claimPending({ target_id: operationIds.targetId, fill_id: operationIds.fillId, observed_at: observedAt, intent }); }
        catch (error) { claimFailure = error; throw error; }
      },
      save: async (...args: Parameters<typeof native.save>) => {
        saving();
        try { await native.save(...args); }
        catch (error) { persistenceFailure = error; throw error; }
      },
    };
    const timer = setTimeout(() => controller.abort(new Error("action deadline")), Math.max(1, deadlineAt-Date.now()));
    try {
      const action = qualifyRelease(challenge, deps, controller.signal);
      const prematureAction = action.then(() => { throw new Error("action completed before receipt save"); }, error => { throw claimFailure ?? error; });
      await bounded("receipt save entry", Promise.race([saveEntered, prematureAction]));
      expect(cancel).toHaveBeenCalledExactlyOnceWith(receipt.order_id);
      expect(place).toHaveBeenCalledTimes(1);
      const failure = await bounded("action deadline", action.then(() => { throw new Error("action unexpectedly succeeded"); }, error => error));
      expect(persistenceFailure).toBeDefined();
      expect(failure).toBe(persistenceFailure);
    } finally {
      clearTimeout(timer);
      release();
      await bounded("native disposal", native.dispose());
      if (blocker) await bounded("row lock release", blocker);
    }
    const saved = await h.tenant.readOperation(ids.targetId, ids.fillId);
    expect(saved).toMatchObject({ status: "pending", order_id: null });
    await expect(qualifyRelease(challenge, { ...deps, load: () => h.tenant.readOperation(ids.targetId, ids.fillId) }, new AbortController().signal)).rejects.toThrow("qualification_receipt_missing");
    expect(place).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(getAppDb().execute(sql`SELECT 1 AS ok`)).resolves.toMatchObject([{ ok: 1 }]);
  });
  it("returns one committed insertion winner, visible through a new tenant handle", async () => {
    const h = await harness("paper");
    const input = h.intent();
    input.intent.attributes = { ...input.intent.attributes, release_qualification: { allocation: "allocation-a", helper: { bootId: "boot-a" } } };
    const claims = await Promise.all(Array.from({ length: 8 }, () => h.tenant.claimPending(input)));
    expect(claims.filter(c => c.inserted)).toHaveLength(1);
    expect(claims.every(c => c.mode === "paper")).toBe(true);
    const restarted = h.ledger.forTenant({ billing_account_id: input.billing_account_id, created_by_user_id: input.created_by_user_id });
    const saved = await restarted.readOperation(input.target_id, input.fill_id);
    expect(saved).toMatchObject({ order_id: null, mode: "paper", attributes: { release_qualification: { allocation: "allocation-a", helper: { bootId: "boot-a" } } } });
    expect(await restarted.claimPending(input)).toEqual({ inserted: false, mode: "paper" });
  });
  it("saves only the exact tenant PK even when other rows share its client id", async () => {
    const h = await harness("paper"), other = await harness("paper");
    const input = h.intent(), foreignInput = other.intent(), sibling = h.intent();
    foreignInput.intent.client_order_id = input.intent.client_order_id;
    sibling.intent.client_order_id = input.intent.client_order_id;
    await h.tenant.claimPending(input);
    await other.tenant.claimPending(foreignInput);
    await h.tenant.claimPending(sibling);
    const before = await h.db.select().from(polyCopyTradeFills).where(eq(polyCopyTradeFills.clientOrderId, input.intent.client_order_id));
    const receipt = {
      client_order_id: input.intent.client_order_id, order_id: "real-paper-receipt",
      status: "partial" as const, submitted_at: observed.toISOString(),
      filled_size_usdc: 0.5, fill_price: 0.25, total_shares: 2, fees_usdc: 0,
    };
    await h.tenant.markReceipt(input.target_id, input.fill_id, receipt);
    expect(await h.tenant.readOperation(input.target_id, input.fill_id)).toMatchObject({
      order_id: "real-paper-receipt", status: "partial", executed_shares: 2,
      attributes: { filled_size_usdc: 0.5, realized_fill_source: "paper_order_receipt" },
    });
    const after = await h.db.select().from(polyCopyTradeFills).where(eq(polyCopyTradeFills.clientOrderId, input.intent.client_order_id));
    for (const original of before.filter(row => row.fillId !== input.fill_id))
      expect(after.find(row => row.fillId === original.fillId)).toEqual(original);
    const wrongPrincipal = h.ledger.forTenant({ billing_account_id: h.account, created_by_user_id: foreignInput.created_by_user_id });
    await expect(wrongPrincipal.markReceipt(input.target_id, input.fill_id, { ...receipt, order_id: "forged" })).rejects.toThrow("ledger_receipt_not_found");
    expect((await h.tenant.readOperation(input.target_id, input.fill_id))?.order_id).toBe("real-paper-receipt");
  });
  it("aborts a native blocked fixture read without closing the shared pool or dispatching later", async () => {
    const { resolveQualificationDependencies } = await import("@/bootstrap/qualification");
    const h = await harness("paper"), input = h.intent();
    let release!: () => void, locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const blocker = h.db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE billing_accounts IN ACCESS EXCLUSIVE MODE`);
      locked();
      await held;
    });
    await acquired;
    const controller = new AbortController();
    const deadlineAt = Date.now() + 250;
    qualificationExecutor.mockClear();
    const deps = resolveQualificationDependencies({ accountId: h.account, ownerId: input.created_by_user_id }, "http://127.0.0.1:9100", controller.signal, deadlineAt);
    expect(() => resolveQualificationDependencies({ accountId: h.account, ownerId: input.created_by_user_id }, "http://127.0.0.1:9100", controller.signal, deadlineAt)).toThrow("qualification_busy");
    const timer = setTimeout(() => controller.abort(new Error("action deadline")), 250);
    try {
      const started = Date.now();
      await expect(deps.checkFixture()).rejects.toThrow();
      await deps.dispose();
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      clearTimeout(timer);
      await deps.dispose();
      release();
      await blocker;
    }
    // The action's native connection was closed; other tenants' app pool survives.
    await expect(getAppDb().execute(sql`SELECT 1 AS ok`)).resolves.toMatchObject([{ ok: 1 }]);
    expect(qualificationExecutor).not.toHaveBeenCalled();
    const next = resolveQualificationDependencies({ accountId: h.account, ownerId: input.created_by_user_id }, "http://127.0.0.1:9100", new AbortController().signal, Date.now() + 1000);
    await next.dispose();
  });
  it("RLS refuses another owner's claim and operation read", async () => {
    const h = await harness("paper"), other = await harness("paper");
    const input = h.intent();
    expect((await h.tenant.claimPending(input)).inserted).toBe(true);
    const foreign = h.ledger.forTenant({ billing_account_id: input.billing_account_id, created_by_user_id: other.intent().created_by_user_id });
    expect(await foreign.readOperation(input.target_id, input.fill_id)).toBeNull();
    await expect(foreign.claimPending({ ...input, fill_id: "foreign-attempt" })).rejects.toThrow();
  });
});

it("reaffirms a registered owner's paper consent without reseeding or replacing grants", async () => {
  const { withTenantScope } = await import("@cogni/db-client");
  const { toUserId, userActor } = await import("@cogni/ids");
  const { provisionPaperAccount } = await import("@/features/paper-accounts");
  const { polyWalletConnections, polyWalletGrants } = await import("@cogni/poly-db-schema");
  const h = await harness("paper");
  const ownerId = h.intent().created_by_user_id;
  const input = { billingAccountId: h.account, createdByUserId: ownerId, actorKind: "user" as const, actorId: ownerId,
    seedUsdc: 1000, defaultGrant: { perOrderUsdcCap: 1, dailyUsdcCap: 200 } };
  const db = getAppDb();
  const first = await withTenantScope(db, userActor(toUserId(ownerId)), tx => provisionPaperAccount(tx, input));
  const grantsBefore = await h.db.select().from(polyWalletGrants).where(eq(polyWalletGrants.billingAccountId, h.account));
  const again = await withTenantScope(db, userActor(toUserId(ownerId)), tx => provisionPaperAccount(tx, { ...input, actorKind: "agent", seedUsdc: 9999 }));
  expect(again).toMatchObject({ connectionId: first.connectionId, created: false, seedUsdc: "1000.00000000" });
  const [row] = await h.db.select().from(polyWalletConnections).where(eq(polyWalletConnections.id, first.connectionId));
  expect(row).toMatchObject({ custodialConsentActorKind: "agent", custodialConsentActorId: ownerId, paperSeedUsdc: "1000.00000000" });
  expect(await h.db.select().from(polyWalletGrants).where(eq(polyWalletGrants.billingAccountId, h.account))).toEqual(grantsBefore);
});

it("retains native qualification singleflight ownership across abort and repeated disposal until close completes", async () => {
  const dbClient = await import("@cogni/db-client");
  const { resolveQualificationDependencies } = await import("@/bootstrap/qualification");
  const h = await harness("paper"), input = h.intent();
  let finishClose!: () => void, enteredClose!: () => void;
  const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
  const closing = new Promise<void>(resolve => { enteredClose = resolve; });
  const create = dbClient.createAppDbClient;
  const end = vi.fn();
  const createClient = vi.spyOn(dbClient, "createAppDbClient").mockImplementation((...args) => {
    const db = create(...args); // Real app-role connection and real tenant query below.
    const nativeEnd = db.$client.end.bind(db.$client);
    vi.spyOn(db.$client, "end").mockImplementation(async options => {
      end();
      enteredClose();
      await closeGate;
      await nativeEnd(options);
    });
    return db;
  });
  const controller = new AbortController();
  const deadlineAt = Date.now() + 1000;
  const fixture = { accountId: h.account, ownerId: input.created_by_user_id };
  const owned = resolveQualificationDependencies(fixture, "http://127.0.0.1:9100", controller.signal, deadlineAt);
  const expired = new Promise<void>(resolve => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
  const timer = setTimeout(() => controller.abort(new Error("response deadline")), deadlineAt - Date.now());
  let disposing: Promise<void> | undefined;
  try {
    await expect(owned.load({ targetId: input.target_id, fillId: input.fill_id, clientOrderId: input.intent.client_order_id })).resolves.toBeNull();
    disposing = owned.dispose();
    await closing;
    await expired;
    expect(Date.now() - deadlineAt).toBeLessThan(1500);
    expect(() => resolveQualificationDependencies(fixture, "http://127.0.0.1:9100", new AbortController().signal, Date.now() + 1000)).toThrow("qualification_busy");
    const repeated = owned.dispose();
    expect(end).toHaveBeenCalledTimes(1);
    expect(createClient).toHaveBeenCalledTimes(1);
    finishClose();
    await repeated;
    const next = resolveQualificationDependencies(fixture, "http://127.0.0.1:9100", new AbortController().signal, Date.now() + 1000);
    await next.dispose();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(2);
    await expect(getAppDb().execute(sql`SELECT 1 AS ok`)).resolves.toMatchObject([{ ok: 1 }]);
  } finally {
    finishClose();
    clearTimeout(timer);
    await owned.dispose();
    await disposing;
    createClient.mockRestore();
  }
});
