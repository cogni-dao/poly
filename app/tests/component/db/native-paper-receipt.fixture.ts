// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Real PaperAdapter/factory/locked-ledger fixture; only the HTTP transport is controlled. */
import { randomUUID } from "node:crypto";
import { noopMetrics, type OrderReceipt } from "@cogni/poly-market-provider";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { and, eq } from "drizzle-orm";
import { expect, vi } from "vitest";
import { createPolyTradeExecutorFactory } from "@/bootstrap/capabilities/poly-trade-executor";
import {
	createExecutionVenueResolver,
	createPaperVenue,
	derivePaperAccountAddress,
} from "@/features/paper-accounts";
import { createOrderLedger } from "@/features/trading/order-ledger";
import { polyWalletConnections, polyWalletGrants } from "@/shared/db/schema";

type NativePaperOwner = { userId: string; billingAccountId: string };
/** Pass the same transaction through every native fixture dependency. */
export type NativePaperFixtureDb = Parameters<typeof createOrderLedger>[0]["db"];
const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	child: () => logger,
};

export async function seedNativePaperConnection(
	owner: NativePaperOwner,
	seedUsdc: string,
	db: NativePaperFixtureDb = getSeedDb(),
): Promise<`0x${string}`> {
	const paperAddress = derivePaperAccountAddress(owner.billingAccountId);
	await db
		.insert(polyWalletConnections)
		.values({
			billingAccountId: owner.billingAccountId,
			createdByUserId: owner.userId,
			createdAt: new Date("2026-10-01T00:00:00.000Z"),
			kind: "paper",
			address: paperAddress,
			funderAddress: paperAddress,
			paperSeedUsdc: seedUsdc,
			custodialConsentAcceptedAt: new Date("2026-10-01T00:00:00.000Z"),
			custodialConsentActorKind: "user",
			custodialConsentActorId: owner.userId,
			tradingApprovalsReadyAt: new Date("2026-10-01T00:00:00.000Z"),
		});
	const [connection] = await db
		.select({ id: polyWalletConnections.id })
		.from(polyWalletConnections)
		.where(
			and(
				eq(polyWalletConnections.billingAccountId, owner.billingAccountId),
				eq(polyWalletConnections.kind, "paper"),
			),
		);
	if (!connection) throw new Error("paper connection missing");
	await db
		.insert(polyWalletGrants)
		.values({
			billingAccountId: owner.billingAccountId,
			walletConnectionId: connection.id,
			createdByUserId: owner.userId,
			scopes: ["poly:trade:buy", "poly:trade:sell"],
			perOrderUsdcCap: "100000",
			dailyUsdcCap: "1000000",
			hourlyFillsCap: 1000,
			createdAt: new Date("2026-10-01T00:00:00.000Z"),
		});
	return paperAddress;
}

export type NativePaperFill = {
	tokenId: string;
	conditionId: string;
	side: "BUY" | "SELL";
	/** Realized VWAP. */
	price: string;
	/** Realized shares. */
	shares: string;
	feesUsdc?: string | null;
	status?: string;
	mode?: string;
	observedAt?: Date;
};

export async function seedNativePaperFill(
	owner: NativePaperOwner,
	targetId: string,
	fill: NativePaperFill,
	db: NativePaperFixtureDb = getSeedDb(),
) {
	const client = `coid-${randomUUID()}`;
	const order = `order-${randomUUID()}`;
	const observedAt = fill.observedAt ?? new Date("2026-10-05T12:00:00.000Z");
	const intent = {
		provider: "polymarket" as const,
		market_id: `prediction-market:polymarket:${fill.conditionId}`,
		outcome: "0",
		side: fill.side,
		size_usdc: Number(fill.price) * Number(fill.shares),
		limit_price: Number(fill.price),
		client_order_id: client,
		attributes: {
			token_id: fill.tokenId,
			condition_id: fill.conditionId,
			placement: "limit",
		},
	};
	const ledger = createOrderLedger({
		db,
		logger: logger as never,
		resolveExecutionMode: createExecutionVenueResolver({ db }),
	});
	await ledger.insertPending({
		billing_account_id: owner.billingAccountId,
		created_by_user_id: owner.userId,
		target_id: targetId,
		fill_id: `paper:${randomUUID()}`,
		observed_at: observedAt,
		intent,
	});
	const accept = async (
		next: Partial<OrderReceipt> = {},
		at = observedAt,
		first = false,
	) => {
		const native: OrderReceipt = {
			order_id: order,
			client_order_id: client,
			status: (fill.status ?? "filled") as OrderReceipt["status"],
			filled_size_usdc: Number(fill.price) * Number(fill.shares),
			fill_price: Number(fill.price),
			total_shares: Number(fill.shares),
			fees_usdc:
				fill.feesUsdc === null ? undefined : Number(fill.feesUsdc ?? "0"),
			submitted_at: observedAt.toISOString(),
			attributes: {
				market: fill.conditionId,
				tokenId: fill.tokenId,
				side: fill.side,
				sizeMatched: Number(fill.shares),
			},
			...next,
		};
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(at);
		const transport = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input, init) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("http://paper.projection.test");
				if (first)
					expect(JSON.parse(String(init?.body)).client_order_id).toBe(client);
				else expect(url.pathname).toBe(`/orders/${order}`);
				return Response.json(native);
			});
		try {
			const factory = createPolyTradeExecutorFactory({
				logger: logger as never,
				metrics: noopMetrics,
				paperSidecarUrl: "http://paper.projection.test",
				paperVenue: createPaperVenue({ db }),
				resolveExecutionVenue: createExecutionVenueResolver({ db }),
			});
			const executor = await factory.getPolyTradeExecutorFor(
				owner.billingAccountId,
			);
			const fetched = first
				? { found: await executor.placeIntent(intent) }
				: await executor.getOrder(order);
			if (!("found" in fetched))
				throw new Error("native paper order unavailable");
			const written = await ledger.markOrderId({
				client_order_id: client,
				receipt: fetched.found,
			});
			expect(written?.accepted).toBe(true);
			return written;
		} finally {
			transport.mockRestore();
			vi.useRealTimers();
		}
	};
	await accept({}, observedAt, true);
	return { client, order, accept };
}
