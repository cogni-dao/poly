// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { randomUUID } from "node:crypto";
import { agentCapabilityGrants } from "@cogni/db-schema/agent-capability-grants";
import {
	polyAlgorithmInputSnapshots,
	polyCopyTradeFills,
} from "@cogni/db-schema/copy-trade";
import {
	polyPositionGapActions,
	polyPositionGapCohorts,
	polyPositionGapReservations,
	polyPositionGapRuns,
} from "@cogni/db-schema/position-gap";
import { toUserId, userActor } from "@cogni/ids";
import { noopLogger, noopMetrics, type OrderReceipt } from "@cogni/poly-market-provider";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/adapters/server/db/client";
import { getAppDb, withTenantScope } from "@/adapters/server/db/client";
import { buildPositionGapBuyIntent, startPositionGapActor } from "@/features/copy-trade/position-gap-actor";
import { PositionGapTargetRefreshCoordinator } from "@/features/copy-trade/position-gap-target-refresh";
import { projectPositionGapCohorts } from "@/features/copy-trade/position-gap-cohorts";
import {
	PositionGapReservationConflictError,
	PositionGapRuntimeStore,
} from "@/features/copy-trade/position-gap-runtime-store";
import { createOrderLedger } from "@/features/trading/order-ledger";
import { createPolyTradeExecutorFactory } from "@/bootstrap/capabilities/poly-trade-executor";
import { runReconcileOnce } from "@/bootstrap/jobs/order-reconciler.job";
import { createExecutionVenueResolver, createPaperVenue, derivePaperAccountAddress } from "@/features/paper-accounts";
import { acceptedPaperProof, decodeFillAccounting, type FillAccountingScope } from "@/features/trading/fill-accounting";
import { copyFillAccountingSql, paperFillAccountingSql } from "@/features/trading/fill-accounting-sql";
import { billingAccounts, polyWalletConnections, polyWalletGrants, users } from "@/shared/db/schema";
import { polyCopyTradeOrdersOperation } from "@cogni/poly-node-contracts";
import { getCopyTradePnlForTenant } from "@/features/wallet-analysis/server/copy-trade-pnl-service";
import { readPositionGapRuntimeByWallet } from "@/features/wallet-analysis/server/position-gap-runtime-read";
import { listCopyTradeOrdersForAccount } from "@/features/wallet-analysis/server/copy-trade-orders-read";
import { targetIdFromWallet } from "@/shared/util/poly-target-id";

const future = new Date("2099-01-01T00:00:00.000Z");
const asOf = new Date("2026-10-08T00:00:00.000Z");
const algorithmHash = `sha256:${"a".repeat(64)}`;
const ledgerSnapshotHash = `sha256:${"b".repeat(64)}`;
const algorithmLineage = {
	algorithm_id: "poly.copy-mirror.position-gap" as const,
	algorithm_version_id: algorithmHash,
	config_hash: algorithmHash,
	input_snapshot_id: algorithmHash,
	assignment_id: "position-gap-component",
	correlation_id: "position-gap-component",
};

describe("authenticated paper cumulative receipt persistence", () => {
	it("repairs terminal equal tuples and known-zero fees through the real factory, ledger, reconciler and SQL", async () => {
		const db = getSeedDb();
		const owner = randomUUID();
    const foreignOwner = randomUUID();
		const account = randomUUID();
		const foreignAccount = randomUUID();
		const connection = randomUUID();
		const target = randomUUID();
		const condition = `0x${"d".repeat(64)}`;
		const token = "1234567890123456789012345678901234567890";
		const client = `paper-proof-${randomUUID()}`;
		const order = `paper-order-${randomUUID()}`;
    await db.insert(users).values([owner, foreignOwner].map(id => ({
      id, name: "Paper proof owner", walletAddress: `0x${id.replaceAll("-", "")}12345678`,
    })));
		await db
			.insert(billingAccounts)
			.values(
				[account, foreignAccount].map((id, index) => ({
					id,
					ownerUserId: index === 0 ? owner : foreignOwner,
					balanceCredits: 0n,
				})),
			);
		const address = derivePaperAccountAddress(account);
		await db.insert(polyWalletConnections).values({
			id: connection,
			billingAccountId: account,
			createdByUserId: owner,
			kind: "paper",
			address,
			funderAddress: address,
			paperSeedUsdc: "100",
			custodialConsentAcceptedAt: asOf,
			custodialConsentActorKind: "user",
			custodialConsentActorId: owner,
			tradingApprovalsReadyAt: asOf,
		});
		await db.insert(polyWalletGrants).values({
			billingAccountId: account,
			walletConnectionId: connection,
			createdByUserId: owner,
			scopes: ["poly:trade:buy"],
			perOrderUsdcCap: "10",
			dailyUsdcCap: "1000",
			hourlyFillsCap: 1000,
		});
		let native: OrderReceipt = {
			order_id: order,
			client_order_id: client,
			status: "filled",
			filled_size_usdc: 1.5,
			fill_price: 0.5,
			total_shares: 3,
			submitted_at: asOf.toISOString(),
			attributes: {
				market: condition,
				tokenId: token,
				side: "BUY",
				sizeMatched: 3,
			},
		};
		const transport = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input, init) => {
				const url = new URL(String(input));
				expect(url.origin).toBe("http://paper.receipt.test");
				if (url.pathname === "/place-order") {
					const request = JSON.parse(String(init?.body));
					expect(request.account_id).toBe(connection);
					expect(request.client_order_id).toBe(native.client_order_id);
				} else {
					expect(url.searchParams.get("account_id")).toBe(connection);
					expect(url.pathname).toBe(`/orders/${native.order_id}`);
				}
				return Response.json(native);
			});
		try {
			const factory = createPolyTradeExecutorFactory({
				logger: noopLogger as never,
				metrics: noopMetrics,
				paperSidecarUrl: "http://paper.receipt.test",
				paperVenue: createPaperVenue({ db }),
				resolveExecutionVenue: createExecutionVenueResolver({ db }),
			});
			const executor = await factory.getPolyTradeExecutorFor(account);
			const ledger = createOrderLedger({
				db,
				logger: noopLogger as never,
				resolveExecutionMode: createExecutionVenueResolver({ db }),
			});
			const intent = {
				provider: "polymarket" as const,
				market_id: `prediction-market:polymarket:${condition}`,
				outcome: "0",
				side: "BUY" as const,
				size_usdc: 2.5,
				limit_price: 0.5,
				client_order_id: client,
				attributes: {
					token_id: token,
					condition_id: condition,
					placement: "limit",
				},
			};
			await ledger.insertPending({
				billing_account_id: account,
				created_by_user_id: owner,
				target_id: target,
				fill_id: `paper-proof:${client}`,
				observed_at: asOf,
				intent,
			});
			const receipt = await executor.placeIntent(intent);
			expect(receipt.paper_context?.connection_id).toBe(connection);
			const first = await ledger.markOrderId({
				client_order_id: client,
				receipt,
			});
			if (!first)
				throw new Error("paper writer returned no durable observation");
			expect(first.accepted).toBe(true);
			expect(first.accounting).toMatchObject({
				status: "verified_positive",
				facts: {
					shares: 3,
					notional_usdc: 1.5,
					price: 0.5,
					fee_known: false,
					fees_usdc: null,
					connection_id: connection,
				},
			});
			const scope: FillAccountingScope = {
				mode: "paper",
				billing_account_id: account,
				connection_id: connection,
				client_order_id: client,
				order_id: order,
				condition_id: condition,
				token_id: token,
				side: "BUY",
			};
			const read = async () => {
				const [row] = await db
					.select()
					.from(polyCopyTradeFills)
					.where(eq(polyCopyTradeFills.clientOrderId, client));
				if (!row) throw new Error("paper proof row missing");
				return row;
			};
			const sqlProof = paperFillAccountingSql("f");
			const readSql = async () => {
				const rows =
					await db.execute(sql`SELECT ${sqlProof.positive} AS positive, ${sqlProof.zero} AS zero,
          ${sqlProof.feeKnown} AS fee_known FROM poly_copy_trade_fills f WHERE f.client_order_id = ${client}`);
				return rows[0];
			};
			expect(
				decodeFillAccounting(await read(), scope, new Date()),
			).toMatchObject({ status: "verified_positive" });
			expect(await readSql()).toMatchObject({
				positive: true,
				zero: false,
				fee_known: false,
			});

      const publicOrders = () => withTenantScope(getAppDb(), userActor(toUserId(owner)), tx =>
        listCopyTradeOrdersForAccount(tx as never, { limit: 200 }, account));
      const liveMissingClient = `live-unverified-${randomUUID()}`;
      await db.insert(polyCopyTradeFills).values({ billingAccountId: account, createdByUserId: owner,
        targetId: target, fillId: liveMissingClient, clientOrderId: liveMissingClient, orderId: `order-${liveMissingClient}`,
        marketId: intent.market_id, mode: "live", status: "filled", shares: "3", price: ".5", observedAt: asOf,
        attributes: { position_gap_version: "3", side: "BUY", token_id: token, filled_size_usdc: 1.5 } });
      const liveGate = copyFillAccountingSql("f");
      const liveUnverified = await db.execute(sql`SELECT ${liveGate.realized} AS realized, ${liveGate.positionGapVerified} AS verified
        FROM poly_copy_trade_fills f WHERE f.client_order_id=${liveMissingClient}`);
      expect(liveUnverified[0]).toEqual({ realized: false, verified: false });
      const livePnl = await getCopyTradePnlForTenant(db, account, "live");
      expect(livePnl).toMatchObject({ summary: { total_realized_size_usdc: 0, accounting_pending_count: 1, fill_accounting_status: "partial" } });
      const publicPositive = polyCopyTradeOrdersOperation.output.parse(await publicOrders());
      expect(publicPositive.orders.find(row => row.client_order_id === client)).toMatchObject({ filled_size_usdc: 1.5,
        fill_accounting: { status: "verified", source: "paper_order_receipt", matched_order_count: 1,
          realized_shares: 3, realized_entry_notional_usdc: 1.5 } });

			// Historical source-only terminal rows must be selected despite the closed
			// lifecycle and unchanged status/cost/source. No immutable fill is rewritten.
			await db
				.update(polyCopyTradeFills)
				.set({
					positionLifecycle: "closed",
					updatedAt: asOf,
					syncedAt: asOf,
					attributes: sql`${polyCopyTradeFills.attributes} - 'paper_receipt_v1'`,
				})
				.where(eq(polyCopyTradeFills.clientOrderId, client));
			expect(
				(await ledger.listOpenOrPending({ olderThanMs: 0 })).some(
					(row) => row.client_order_id === client,
				),
			).toBe(true);
			const foreignClient = `paper-foreign-sentinel-${randomUUID()}`;
			await db
				.insert(polyCopyTradeFills)
				.values({
					billingAccountId: foreignAccount,
					createdByUserId: foreignOwner,
					targetId: target,
					fillId: foreignClient,
					marketId: intent.market_id,
					observedAt: asOf,
					clientOrderId: foreignClient,
					orderId: `foreign-${foreignClient}`,
					mode: "paper",
					status: "filled",
					updatedAt: asOf,
					syncedAt: asOf,
					attributes: { position_gap_version: "3" },
				});
			const foreignClock = async () => {
				const [row] = await db
					.select({
						updated: polyCopyTradeFills.updatedAt,
						synced: polyCopyTradeFills.syncedAt,
					})
					.from(polyCopyTradeFills)
					.where(eq(polyCopyTradeFills.clientOrderId, foreignClient));
				return row;
			};
			const foreignBefore = await foreignClock();
			const observedTenants: string[] = [];
			const reconcile = async () => {
				await runReconcileOnce({
					ledger: {
						...ledger,
						listOpenOrPending: async (input) =>
							(await ledger.listOpenOrPending(input)).filter(
								(row) =>
									row.billing_account_id === account &&
									row.client_order_id === client,
							),
					},
					logger: noopLogger,
					metrics: noopMetrics,
					notFoundGraceMs: 0,
					getOrderForTenant: async (billing, orderId, mode) => {
						observedTenants.push(billing);
						expect(billing).toBe(account);
						expect(mode).toBe("paper");
						return executor.getOrder(orderId);
					},
				});
				expect(observedTenants.every((billing) => billing === account)).toBe(
					true,
				);
				expect(await foreignClock()).toEqual(foreignBefore);
			};
			await reconcile();
			const repaired = await read();
			expect(repaired.positionLifecycle).toBe("closed");
			expect(repaired.attributes?.paper_receipt_v1).toBeDefined();
			expect(
				acceptedPaperProof(decodeFillAccounting(repaired, scope, new Date()))
					?.fee_known,
			).toBe(false);

			native = { ...native, fees_usdc: 0 };
			await db
				.update(polyCopyTradeFills)
				.set({ updatedAt: asOf, syncedAt: asOf })
				.where(eq(polyCopyTradeFills.clientOrderId, client));
			await reconcile();
			const known = await read();
			expect(Number(known.shares)).toBe(3);
			expect(Number(known.feesUsdc)).toBe(0);
			expect(known.attributes?.filled_size_usdc).toBe(1.5);
			expect(await readSql()).toMatchObject({
				positive: true,
				zero: false,
				fee_known: true,
			});
			const knownProof = acceptedPaperProof(
				decodeFillAccounting(known, scope, new Date()),
			);
			expect(knownProof?.fee_known).toBe(true);
			const repeat = await executor.getOrder(order);
			if (!("found" in repeat))
				throw new Error("paper receipt unexpectedly absent");
			await ledger.markOrderId({
				client_order_id: client,
				receipt: repeat.found,
			});
			expect((await read()).attributes?.paper_receipt_v1).toEqual(
				known.attributes?.paper_receipt_v1,
			);
			expect(
				(await ledger.listOpenOrPending({ olderThanMs: 0 })).some(
					(row) => row.client_order_id === client,
				),
			).toBe(false);

			for (const conflict of [
				{ total_shares: 4, fill_price: 0.25, filled_size_usdc: 1 },
				{ total_shares: 3, fill_price: 1 / 3, filled_size_usdc: 1 },
			]) {
				native = {
					...native,
					...conflict,
					attributes: {
						...native.attributes,
						sizeMatched: conflict.total_shares,
					},
				};
				const incoming = await executor.getOrder(order);
				if (!("found" in incoming))
					throw new Error("conflicting receipt unexpectedly absent");
				const rejected = await ledger.markOrderId({
					client_order_id: client,
					receipt: incoming.found,
				});
				if (!rejected)
					throw new Error("paper writer returned no durable observation");
				expect(rejected.accepted).toBe(false);
				expect((await read()).attributes).toEqual(known.attributes);
			}
			native = {
				...native,
				filled_size_usdc: 1.5,
				total_shares: 3,
				fill_price: 0.5,
				attributes: {
					...native.attributes,
					sizeMatched: 3,
					tokenId: "9999999999999999999999999",
				},
			};
			const wrongToken = await executor.getOrder(order);
			if (!("found" in wrongToken))
				throw new Error("wrong token receipt unexpectedly absent");
			const wrongTokenWrite = await ledger.markOrderId({
				client_order_id: client,
				receipt: wrongToken.found,
			});
			if (!wrongTokenWrite)
				throw new Error("paper writer returned no durable observation");
			expect(wrongTokenWrite.accepted).toBe(false);
			expect((await read()).attributes).toEqual(known.attributes);

			// Malformed historical JSON must return false, never throw a SQL cast error.
			for (const invalid of [
				"not-a-number",
				"NaN",
				"Infinity",
				"1e99999",
				null,
			]) {
				await db
					.update(polyCopyTradeFills)
					.set({
						attributes: sql`jsonb_set(${JSON.stringify(known.attributes)}::jsonb,
          '{paper_receipt_v1,shares}', ${JSON.stringify(invalid)}::jsonb)`,
					})
					.where(eq(polyCopyTradeFills.clientOrderId, client));
				expect(await readSql()).toMatchObject({ positive: false, zero: false });
				expect(
					decodeFillAccounting(await read(), scope, new Date()).status,
				).not.toBe("verified_positive");
			}
			await db
				.update(polyCopyTradeFills)
				.set({ attributes: known.attributes })
				.where(eq(polyCopyTradeFills.clientOrderId, client));
			expect(decodeFillAccounting(await read(), scope, asOf).status).toBe(
				"pending",
			);
			const oldCutoff = paperFillAccountingSql(
				"f",
				sql`${asOf.toISOString()}::timestamptz`,
			);
			const past = await db.execute(
				sql`SELECT ${oldCutoff.positive} AS positive FROM poly_copy_trade_fills f WHERE f.client_order_id = ${client}`,
			);
			expect(past[0]?.positive).toBe(false);

			// These independent decimals exercise binary/decimal half boundaries. The
			// authoritative envelope retains native precision; the existing columns
			// must use PostgreSQL numeric rounding on both the writer and reader.
			native = {
				...native,
				total_shares: 3.250000005,
				fill_price: 0.500000005,
				filled_size_usdc: 1.62500001875,
				fees_usdc: 0.000000005,
				attributes: {
					market: condition,
					tokenId: token,
					side: "BUY",
					sizeMatched: 3.250000005,
				},
			};
			const halfBoundary = await executor.getOrder(order);
			if (!("found" in halfBoundary))
				throw new Error("half-boundary receipt unexpectedly absent");
			const halfWrite = await ledger.markOrderId({
				client_order_id: client,
				receipt: halfBoundary.found,
			});
			if (!halfWrite)
				throw new Error("paper writer returned no durable observation");
			expect(halfWrite.accepted).toBe(true);
			const rounded = await read();
			expect(rounded.shares).toBe("3.25000001");
			expect(rounded.price).toBe("0.50000001");
			expect(rounded.feesUsdc).toBe("0.00000001");
			expect(
				acceptedPaperProof(decodeFillAccounting(rounded, scope, new Date())),
			).toMatchObject({
				shares: 3.250000005,
				price: 0.500000005,
				fees_usdc: 0.000000005,
				notional_usdc: 1.62500001875,
			});
			expect(await readSql()).toMatchObject({
				positive: true,
				zero: false,
				fee_known: true,
			});
			const decimalOracle =
				await db.execute(sql`SELECT round(3.250000005::numeric, 8)::text AS shares,
        round(0.500000005::numeric, 8)::text AS price, round(0.000000005::numeric, 8)::text AS fee`);
			expect(decimalOracle[0]).toMatchObject({
				shares: "3.25000001",
				price: "0.50000001",
				fee: "0.00000001",
			});

			// Missing envelopes compare native observations against the precision of
			// the legacy columns, rather than falsely calling half-rounding regression.
			await db
				.update(polyCopyTradeFills)
				.set({
					positionLifecycle: "closed",
					updatedAt: asOf,
					syncedAt: asOf,
					attributes: sql`${polyCopyTradeFills.attributes} - 'paper_receipt_v1'`,
				})
				.where(eq(polyCopyTradeFills.clientOrderId, client));
			await reconcile();
			expect((await read()).shares).toBe("3.25000001");
			expect(
				acceptedPaperProof(
					decodeFillAccounting(await read(), scope, new Date()),
				)?.shares,
			).toBe(3.250000005);
			expect(await readSql()).toMatchObject({
				positive: true,
				fee_known: true,
			});

			// Clocks are intentionally absent from semantic keys. A matching key is
			// insufficient when the saved proof has an invalid or future observation.
			for (const corruptClock of [
				"not-an-observation-clock",
				"2099-01-01T00:00:00.000Z",
			]) {
				const beforeClockRepair = await read();
				const beforeProof = acceptedPaperProof(
					decodeFillAccounting(beforeClockRepair, scope, new Date()),
				);
				if (!beforeProof)
					throw new Error("clock-repair starting proof missing");
				await db
					.update(polyCopyTradeFills)
					.set({
						updatedAt: asOf,
						syncedAt: asOf,
						attributes: sql`jsonb_set(${JSON.stringify(beforeClockRepair.attributes)}::jsonb,
            '{paper_receipt_v1,observed_at}', ${JSON.stringify(corruptClock)}::jsonb)`,
					})
					.where(eq(polyCopyTradeFills.clientOrderId, client));
				expect(await readSql()).toMatchObject({ positive: false });
				const selected = (
					await ledger.listOpenOrPending({ olderThanMs: 0 })
				).find((row) => row.client_order_id === client);
				expect(selected?.client_order_id).toBe(client);
				await reconcile();
				const afterProof = acceptedPaperProof(
					decodeFillAccounting(await read(), scope, new Date()),
				);
				expect(afterProof?.proof_key).toBe(beforeProof.proof_key);
				expect(afterProof?.observed_at).not.toBe(corruptClock);
				expect(await readSql()).toMatchObject({
					positive: true,
					fee_known: true,
				});
			}

			const monotonicBefore = await read();
			native = {
				...native,
				total_shares: 3.24999999,
				fill_price: 0.5,
				filled_size_usdc: 1.624999995,
				attributes: { ...native.attributes, sizeMatched: 3.24999999 },
			};
			const regressedNative = await executor.getOrder(order);
			if (!("found" in regressedNative))
				throw new Error("regression control receipt absent");
			const regressionWrite = await ledger.markOrderId({
				client_order_id: client,
				receipt: regressedNative.found,
			});
			if (!regressionWrite)
				throw new Error("regression control durable result absent");
			expect(regressionWrite.accepted).toBe(false);
			expect((await read()).attributes).toEqual(monotonicBefore.attributes);

			const zeroClient = `paper-zero-${randomUUID()}`;
			const zeroOrder = `paper-zero-order-${randomUUID()}`;
			const zeroToken = "9876543210987654321098765432109876543210";
			const zeroIntent = {
				...intent,
				client_order_id: zeroClient,
				attributes: { ...intent.attributes, token_id: zeroToken },
			};
			await ledger.insertPending({
				billing_account_id: account,
				created_by_user_id: owner,
				target_id: target,
				fill_id: `paper-proof:${zeroClient}`,
				observed_at: asOf,
				intent: zeroIntent,
			});
			native = {
				order_id: zeroOrder,
				client_order_id: zeroClient,
				status: "canceled",
				filled_size_usdc: 0,
				fees_usdc: 0,
				submitted_at: asOf.toISOString(),
				attributes: {
					market: condition,
					tokenId: zeroToken,
					side: "BUY",
					sizeMatched: 0,
				},
			};
			const zeroReceipt = await executor.placeIntent(zeroIntent);
			const zeroWrite = await ledger.markOrderId({
				client_order_id: zeroClient,
				receipt: zeroReceipt,
			});
			if (!zeroWrite)
				throw new Error("zero writer returned no durable observation");
			expect(zeroWrite.accepted).toBe(true);
			expect(zeroWrite.accounting).toMatchObject({
				status: "verified_zero",
				finalProof: {
					shares: 0,
					notional_usdc: 0,
					price: null,
					fee_known: true,
					fees_usdc: 0,
					terminal: true,
				},
			});
			const [zeroRow] = await db
				.select()
				.from(polyCopyTradeFills)
				.where(eq(polyCopyTradeFills.clientOrderId, zeroClient));
			if (!zeroRow) throw new Error("zero durable row missing");
			expect(zeroRow.attributes?.final_order_observation).toMatchObject({
				order_id: zeroOrder,
				filled_size_usdc: 0,
				status: "canceled",
			});
			expect(
				decodeFillAccounting(
					zeroRow,
					{
						...scope,
						client_order_id: zeroClient,
						order_id: zeroOrder,
						token_id: zeroToken,
					},
					new Date(),
				).status,
			).toBe("verified_zero");
			const zeroSql =
				await db.execute(sql`SELECT ${sqlProof.positive} AS positive, ${sqlProof.zero} AS zero
        FROM poly_copy_trade_fills f WHERE f.client_order_id = ${zeroClient}`);
			expect(zeroSql[0]).toMatchObject({ positive: false, zero: true });
      const publicZero = polyCopyTradeOrdersOperation.output.parse(await publicOrders());
      expect(publicZero.orders.find(row => row.client_order_id === zeroClient)).toMatchObject({ filled_size_usdc: 0,
        fill_accounting: { status: "verified_zero", source: "paper_order_receipt", matched_order_count: 1,
          realized_shares: 0, realized_entry_notional_usdc: 0 } });

			for (const protectedNative of [false, true]) {
				const upgradeClient = `paper-authority-floor-${randomUUID()}`;
				const upgradeOrder = `paper-authority-order-${randomUUID()}`;
				const upgradeIntent = {
					...intent,
					size_usdc: 8,
					limit_price: 2 / 3,
					client_order_id: upgradeClient,
					attributes: {
						...intent.attributes,
						token_id: "5555555555555555555555555555555555555555",
					},
				};
				await ledger.insertPending({
					billing_account_id: account,
					created_by_user_id: owner,
					target_id: target,
					fill_id: `paper-proof:${upgradeClient}`,
					observed_at: asOf,
					intent: upgradeIntent,
				});
				native = {
					order_id: upgradeOrder,
					client_order_id: upgradeClient,
					status: "filled",
					filled_size_usdc: protectedNative ? 8 : 6,
					total_shares: 12,
					fill_price: protectedNative ? 2 / 3 : 0.5,
					fees_usdc: 0,
					submitted_at: asOf.toISOString(),
					attributes: {
						market: condition,
						tokenId: upgradeIntent.attributes.token_id,
						side: "BUY",
						sizeMatched: 12,
					},
				};
				if (!protectedNative) {
					// The prior $8 is explicitly unprotected estimated/cross-mode cost.
					await db
						.update(polyCopyTradeFills)
						.set({
							shares: "12",
							price: "0.66666667",
							feesUsdc: "0",
							attributes: sql`${polyCopyTradeFills.attributes} || '{"filled_size_usdc":8,"realized_fill_source":"data_api_activity_position"}'::jsonb`,
						})
						.where(eq(polyCopyTradeFills.clientOrderId, upgradeClient));
				}
				const authoritative = await executor.placeIntent(upgradeIntent);
				const write = await ledger.markOrderId({
					client_order_id: upgradeClient,
					receipt: authoritative,
				});
				if (!write) throw new Error("authority floor observation absent");
				expect(write.accepted).toBe(true);
				const [durable] = await db
					.select()
					.from(polyCopyTradeFills)
					.where(eq(polyCopyTradeFills.clientOrderId, upgradeClient));
				expect(durable?.attributes?.filled_size_usdc).toBe(
					protectedNative ? 8 : 6,
				);
				expect(durable?.attributes?.realized_fill_source).toBe(
					"paper_order_receipt",
				);
				if (protectedNative) {
					native = { ...native, filled_size_usdc: 6, fill_price: 0.5 };
					const regressed = await executor.getOrder(upgradeOrder);
					if (!("found" in regressed))
						throw new Error("protected regression receipt absent");
					const rejection = await ledger.markOrderId({
						client_order_id: upgradeClient,
						receipt: regressed.found,
					});
					if (!rejection) throw new Error("protected regression result absent");
					expect(rejection.accepted).toBe(false);
					const [retained] = await db
						.select()
						.from(polyCopyTradeFills)
						.where(eq(polyCopyTradeFills.clientOrderId, upgradeClient));
					expect(retained?.attributes).toEqual(durable?.attributes);
				}
			}

      for (const feeKnown of [false, true]) {
        const feeClient = `paper-fee-floor-${randomUUID()}`;
        const feeOrder = `native-fee-${feeClient}`;
        const feeIntent = { ...intent, client_order_id: feeClient };
        await ledger.insertPending({ billing_account_id: account, created_by_user_id: owner, target_id: target,
          fill_id: feeClient, observed_at: asOf, intent: feeIntent });
        await db.update(polyCopyTradeFills).set({ feesUsdc: "1", attributes: sql`${polyCopyTradeFills.attributes} || '{"realized_fill_source":"estimated"}'::jsonb` })
          .where(eq(polyCopyTradeFills.clientOrderId, feeClient));
        native = { order_id: feeOrder, client_order_id: feeClient, status: "filled", filled_size_usdc: 1.5,
          total_shares: 3, fill_price: 0.5, ...(feeKnown ? { fees_usdc: 1 } : {}), submitted_at: asOf.toISOString(),
          attributes: { market: condition, tokenId: token, side: "BUY", sizeMatched: 3 } };
        const initialFeeReceipt = await executor.placeIntent(feeIntent);
        const firstFeeWrite = await ledger.markOrderId({ client_order_id: feeClient, receipt: initialFeeReceipt });
        if (!firstFeeWrite) throw new Error("fee floor initial observation absent");
        expect(firstFeeWrite.accepted).toBe(true);
        expect(acceptedPaperProof(firstFeeWrite.accounting)?.fee_known).toBe(feeKnown);
        native = { ...native, fees_usdc: 0 };
        const zeroFee = await executor.getOrder(feeOrder);
        if (!("found" in zeroFee)) throw new Error("fee floor zero observation absent");
        const zeroFeeWrite = await ledger.markOrderId({ client_order_id: feeClient, receipt: zeroFee.found });
        if (!zeroFeeWrite) throw new Error("fee floor zero result absent");
        expect(zeroFeeWrite.accepted).toBe(!feeKnown);
        expect(acceptedPaperProof(zeroFeeWrite.accounting)).toMatchObject({ fee_known: true, fees_usdc: feeKnown ? 1 : 0 });
        const [feeRow] = await db.select().from(polyCopyTradeFills).where(eq(polyCopyTradeFills.clientOrderId, feeClient));
        expect(Number(feeRow?.feesUsdc)).toBe(feeKnown ? 1 : 0);
      }

			// Counterexample fixed by the terminal-transition guard: A reserves five,
			// executes two, cancels three; B reserves five. A's fee/proof upgrades must
			// leave remaining/open/acquired at 3/5/2, including after a process crash.
			for (const executed of [2, 0]) {
				const wallet =
					`0x${executed === 2 ? "7" : "8"}${"1".repeat(39)}` as `0x${string}`;
				const runtimeTarget = targetIdFromWallet(wallet);
				const runtimeScope = {
					billingAccountId: account,
					createdByUserId: owner,
					targetId: runtimeTarget,
				};
				const cohortKey = `paper-once-${randomUUID()}`;
				const runtimeCondition = `0x${(executed === 2 ? "a" : "b").repeat(64)}`;
				const runtimeToken = `${executed + 1}${"2".repeat(37)}`;
				const store = new PositionGapRuntimeStore(db);
				const common = {
					scope: runtimeScope,
					triggerReasons: ["activation"],
					snapshot: {
						id: cohortKey,
						hash: cohortKey,
						asOf,
						expiresAt: future,
						value: { version: 1, complete: true },
					},
					plannerVersion: "test",
					budgetUsdc: 100,
					eligibleNetNavUsdc: 100,
					scale: 1,
					walletCashUsdc: 100,
					plan: { version: 1, status: "ready", blockReason: null, diagnostics: [], intents: [], lockedOverweights: [] },
					cohortReductions: [],
				};
				const buyInput = (suffix: string) => ({
					actionKey: `${cohortKey}-${suffix}`,
					cohortKey,
					conditionId: runtimeCondition,
					tokenId: runtimeToken,
					marketId: `prediction-market:polymarket:${runtimeCondition}`,
					outcome: "0",
					shares: 5,
					notionalUsdc: 2.5,
					limitPrice: 0.5,
					clientOrderId: `${cohortKey}-${suffix}`,
					plannerAction: { side: "BUY" },
				});
				const initial = await store.persistPlan({
					...common,
					cohortCreations: [
						{
							cohortKey,
							sourceKind: "activation",
							sourceEventId: null,
							sourceConfigRevision: "proof-recovery-v1",
							conditionId: runtimeCondition,
							tokenId: runtimeToken,
							marketId: `prediction-market:polymarket:${runtimeCondition}`,
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
					buys: [buyInput("a")],
					cancellations: [],
				});
				const a = initial.buys[0];
				if (!a) throw new Error("paper once-only action A absent");
				const runtimeIntent = (clientId: string) => ({
					...intent,
					client_order_id: clientId,
					market_id: `prediction-market:polymarket:${runtimeCondition}`,
					attributes: {
						...intent.attributes,
						condition_id: runtimeCondition,
						token_id: runtimeToken,
						target_wallet: wallet,
						position_gap_version: "3",
						position_gap_cohort_key: cohortKey,
					},
				});
				const aOrder = `native-${a.clientOrderId}`;
				await ledger.insertPending({
					billing_account_id: account,
					created_by_user_id: owner,
					target_id: runtimeTarget,
					fill_id: `position-gap-v3:${a.actionKey}`,
					observed_at: asOf,
					intent: runtimeIntent(a.clientOrderId),
				});
				await store.markLedgered(a.id);
				await store.markSubmitting(a.id);
				native = {
					order_id: aOrder,
					client_order_id: a.clientOrderId,
					status: executed ? "partial" : "open",
					filled_size_usdc: executed / 2,
					...(executed ? { total_shares: executed, fill_price: 0.5 } : {}),
					submitted_at: asOf.toISOString(),
					attributes: {
						market: runtimeCondition,
						tokenId: runtimeToken,
						side: "BUY",
						sizeMatched: executed,
					},
				};
				const aReceipt = await executor.placeIntent(
					runtimeIntent(a.clientOrderId),
				);
				const aAccepted = await ledger.markOrderId({
					client_order_id: a.clientOrderId,
					receipt: aReceipt,
				});
				if (!aAccepted) throw new Error("A accepted observation absent");
				await store.markPlacementReceipt(a.id, undefined, aAccepted);
				const cancelPlan = await store.persistPlan({
					...common,
					cohortCreations: [],
					buys: [],
					cancellations: [
						{
							actionKey: `${cohortKey}-cancel`,
							cohortKey,
							orderId: aOrder,
							reason: "runtime_safety",
							plannerAction: { reason: "runtime_safety" },
						},
					],
				});
				const cancellation = cancelPlan.cancellations[0];
				if (!cancellation) throw new Error("paper cancellation absent");
				native = { ...native, status: "canceled" };
				const canceled = await executor.getOrder(aOrder);
				if (!("found" in canceled))
					throw new Error("paper canceled receipt absent");
				const canceledAccepted = await ledger.markOrderId({
					client_order_id: a.clientOrderId,
					receipt: canceled.found,
				});
				if (!canceledAccepted)
					throw new Error("paper cancellation accepted observation absent");
				await store.markPlacementReceipt(a.id, undefined, canceledAccepted);
				await store.markCancelConfirmed(cancellation.id);
				const next = await store.persistPlan({
					...common,
					cohortCreations: [],
					buys: [buyInput("b")],
					cancellations: [],
				});
				const b = next.buys[0];
				if (!b) throw new Error("paper once-only action B absent");
				await ledger.insertPending({
					billing_account_id: account,
					created_by_user_id: owner,
					target_id: runtimeTarget,
					fill_id: `position-gap-v3:${b.actionKey}`,
					observed_at: asOf,
					intent: runtimeIntent(b.clientOrderId),
				});
				await store.markLedgered(b.id);
				await store.markSubmitting(b.id);
				native = {
					order_id: `native-${b.clientOrderId}`,
					client_order_id: b.clientOrderId,
					status: "open",
					filled_size_usdc: 0,
					submitted_at: asOf.toISOString(),
					attributes: {
						market: runtimeCondition,
						tokenId: runtimeToken,
						side: "BUY",
						sizeMatched: 0,
					},
				};
				const bReceipt = await executor.placeIntent(
					runtimeIntent(b.clientOrderId),
				);
				const bAccepted = await ledger.markOrderId({
					client_order_id: b.clientOrderId,
					receipt: bReceipt,
				});
				if (!bAccepted) throw new Error("B acknowledgement absent");
				await store.markPlacementReceipt(b.id, undefined, bAccepted);
				const readRuntime = async () => {
					const [cohort] = await db
						.select()
						.from(polyPositionGapCohorts)
						.where(eq(polyPositionGapCohorts.cohortKey, cohortKey));
					const actions = await db
						.select()
						.from(polyPositionGapActions)
						.where(
							inArray(polyPositionGapActions.id, [a.id, b.id, cancellation.id]),
						);
					const reservations = await db
						.select()
						.from(polyPositionGapReservations)
						.where(
							inArray(polyPositionGapReservations.buyActionId, [a.id, b.id]),
						);
					return { cohort, actions, reservations };
				};
				const baseline = await readRuntime();
				expect(Number(baseline.cohort?.remainingShares)).toBe(5 - executed);
				expect(Number(baseline.cohort?.openOrderShares)).toBe(5);
				expect(Number(baseline.cohort?.acquiredShares)).toBe(executed);
				const economicState = (
					state: Awaited<ReturnType<typeof readRuntime>>,
				) => ({
					cohort: {
						remaining: state.cohort?.remainingShares,
						open: state.cohort?.openOrderShares,
						acquired: state.cohort?.acquiredShares,
						status: state.cohort?.status,
					},
					reservations: state.reservations,
					actions: state.actions
						.map(
							({
								id,
								desiredShares,
								notionalUsdc,
								filledShares,
								filledUsdc,
								status,
								submittedAt,
								completedAt,
							}) => ({
								id,
								desiredShares,
								notionalUsdc,
								filledShares,
								filledUsdc,
								status,
								submittedAt,
								completedAt,
							}),
						)
						.sort((x, y) => x.id.localeCompare(y.id)),
				});
				// Durable ledger write succeeds, then the process dies before action publication.
				native = { ...canceled.found, fees_usdc: 0 };
				const feeReceipt = await executor.getOrder(aOrder);
				if (!("found" in feeReceipt))
					throw new Error("paper fee upgrade absent");
				const feeAccepted = await ledger.markOrderId({
					client_order_id: a.clientOrderId,
					receipt: feeReceipt.found,
				});
				if (!feeAccepted)
					throw new Error("paper fee accepted observation absent");
				const proof = acceptedPaperProof(feeAccepted.accounting);
				if (!proof) throw new Error("paper fee proof absent");
				const restartedStore = new PositionGapRuntimeStore(db);
				expect(
					(await restartedStore.loadPlannerState(runtimeScope)).activeBuys.map(
						(entry) => entry.id,
					),
				).toContain(a.id);
				const unavailable = vi.fn(async () => {
					throw new Error("controlled unavailable venue");
				});
				const actor = startPositionGapActor({
					implementationRevision: "f".repeat(40),
					targetRowId: randomUUID(),
					isAssignmentCurrent: async () => true,
					scope: runtimeScope,
					targetWallet: wallet,
					configRevision: "proof-recovery-v1",
					configuredBudgetUsdc: 100,
					positionGapBudgetGroup: {
						positionGapTargetCount: 1,
						explicitBudgetTotalUsdc: 100,
						automaticTargetCount: 0,
						unbudgetedTargetCount: 0,
					},
					source: { fetchSince: unavailable },
					refresh: new PositionGapTargetRefreshCoordinator({
						readFresh: () => null,
						refreshFull: unavailable,
						refreshDirty: unavailable,
						invalidate: () => {},
					}),
					store: restartedStore,
					ledger,
					getExecutionMode: async () => "paper",
					executionForMode: () => ({
						placeBuy: unavailable,
						cancelBuy: unavailable,
						getBuy: unavailable,
						getMarketConstraints: unavailable,
						listOpenOrders: unavailable,
					}),
					fillEvidence: {
						getWalletAddress: unavailable,
						listActivity: unavailable,
						listPositions: unavailable,
					},
					getWalletCashUsdc: unavailable,
					getTargetCashUsdc: unavailable,
					getAuthoritativeHoldings: unavailable,
					publishTargetSnapshot: unavailable,
					logger: noopLogger as never,
				});
				try {
					await vi.waitFor(async () => {
						const state = await readRuntime();
						expect(
							state.actions.find((entry) => entry.id === a.id)?.plannerAction,
						).toMatchObject({
							accepted_paper_proof_key: proof.proof_key,
							accepted_paper_fee_known: true,
							accepted_paper_fees_usdc: 0,
						});
						expect(unavailable).toHaveBeenCalled();
					});
					expect(economicState(await readRuntime())).toEqual(
						economicState(baseline),
					);
					await restartedStore.markPlacementReceipt(
						a.id,
						undefined,
						feeAccepted,
					);
					expect(economicState(await readRuntime())).toEqual(
						economicState(baseline),
					);
					// Legacy terminal actions may have published the same economics before
					// the envelope existed. Missing keys are never a new cancellation.
					await db
						.update(polyPositionGapActions)
						.set({
							plannerAction: sql`${polyPositionGapActions.plannerAction} - 'accepted_paper_proof_key'`,
						})
						.where(eq(polyPositionGapActions.id, a.id));
					await restartedStore.markPlacementReceipt(
						a.id,
						undefined,
						feeAccepted,
					);
					expect(economicState(await readRuntime())).toEqual(
						economicState(baseline),
					);
				} finally {
					await actor.stop().catch(() => {});
				}
        if (executed === 2) {
          const historicRuntime = await withTenantScope(getAppDb(), userActor(toUserId(owner)), tx =>
            readPositionGapRuntimeByWallet(tx as never, account, [wallet], new Date(asOf.getTime() + 1000)));
          expect(historicRuntime.get(wallet)).toMatchObject({ status: "observed", execution: {
            fill_accounting: { status: "pending" }, recent_orders: expect.arrayContaining([
              expect.objectContaining({ client_order_id: a.clientOrderId, fill_accounting: { status: "pending", source: "clob_order_receipt" } }),
            ]) } });
        }
        if (executed === 0) {
          const publicRuntime = () => withTenantScope(getAppDb(), userActor(toUserId(owner)), tx =>
            readPositionGapRuntimeByWallet(tx as never, account, [wallet], new Date()));
          const expectPendingRuntime = async () => expect((await publicRuntime()).get(wallet)).toMatchObject({
            status: "observed", execution: { fill_accounting: { status: "pending" } } });
          await expectPendingRuntime();
          await db.update(polyCopyTradeFills).set({ mode: "live" }).where(eq(polyCopyTradeFills.clientOrderId, b.clientOrderId));
          await expectPendingRuntime();
          // The schema permits a legacy non-BUY action with a client binding.
          // It must not count toward the BUY zero-proof denominator.
          await db.update(polyPositionGapActions).set({ kind: "cancel" }).where(eq(polyPositionGapActions.id, a.id));
          await expectPendingRuntime();
          await db.update(polyPositionGapActions).set({ kind: "buy" }).where(eq(polyPositionGapActions.id, a.id));
          await db.update(polyCopyTradeFills).set({ mode: "paper" }).where(eq(polyCopyTradeFills.clientOrderId, b.clientOrderId));
          native = { order_id: `native-${b.clientOrderId}`, client_order_id: b.clientOrderId, status: "partial",
            filled_size_usdc: 1.5, total_shares: 3, fill_price: .5, fees_usdc: 0, submitted_at: asOf.toISOString(),
            attributes: { market: runtimeCondition, tokenId: runtimeToken, side: "BUY", sizeMatched: 3 } };
          const bNative = await executor.getOrder(native.order_id);
          if (!("found" in bNative)) throw new Error("positive crash control native absent");
          const bDurable = await ledger.markOrderId({ client_order_id: b.clientOrderId, receipt: bNative.found });
          if (!bDurable) throw new Error("positive crash control durable result absent");
          expect(bDurable.accepted).toBe(true);
          // B's action still reports zero: A's true final-zero cannot hide B's
          // accepted positive ledger economics while publication is interrupted.
          expect(Number((await readRuntime()).actions.find(entry => entry.id === b.id)?.filledShares)).toBe(0);
          await expectPendingRuntime();
        }
			}
		} finally {
			transport.mockRestore();
			await db
				.delete(polyPositionGapReservations)
				.where(eq(polyPositionGapReservations.billingAccountId, account));
			await db
				.delete(polyPositionGapActions)
				.where(eq(polyPositionGapActions.billingAccountId, account));
			await db
				.delete(polyPositionGapCohorts)
				.where(eq(polyPositionGapCohorts.billingAccountId, account));
			await db
				.delete(polyPositionGapRuns)
				.where(eq(polyPositionGapRuns.billingAccountId, account));
			await db
				.delete(polyCopyTradeFills)
				.where(
					inArray(polyCopyTradeFills.billingAccountId, [
						account,
						foreignAccount,
					]),
				);
			await db
				.delete(polyWalletGrants)
				.where(eq(polyWalletGrants.billingAccountId, account));
			await db
				.delete(polyWalletConnections)
				.where(eq(polyWalletConnections.billingAccountId, account));
			await db
				.delete(billingAccounts)
				.where(inArray(billingAccounts.id, [account, foreignAccount]));
			await db.delete(users).where(inArray(users.id, [owner, foreignOwner]));
		}
	});
});

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
			inputSnapshot: {
				input_snapshot_id: algorithmHash,
				algorithm_id: "poly.copy-mirror.position-gap",
				input_contract_version: "position-gap-book-input-v2",
				canonical_input: { version: 2, exact: "planner-input-a" },
				quality: { validation: "validated" },
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
		const snapshots = await db
			.select()
			.from(polyAlgorithmInputSnapshots)
			.where(eq(polyAlgorithmInputSnapshots.billingAccountId, accountA));
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0]?.canonicalInput).toEqual({
			version: 2,
			exact: "planner-input-a",
		});
		const runs = await db
			.select({
				inputSnapshotId: polyPositionGapRuns.inputSnapshotId,
				targetSnapshot: polyPositionGapRuns.targetSnapshot,
			})
			.from(polyPositionGapRuns)
			.where(eq(polyPositionGapRuns.billingAccountId, accountA));
		expect(runs.length).toBeGreaterThan(0);
		expect(runs.every((run) => run.inputSnapshotId === algorithmHash)).toBe(true);
		expect(runs.every((run) => run.targetSnapshot === null)).toBe(true);
		await expect(
			store.persistPlan({
				...base,
				inputSnapshot: {
					...base.inputSnapshot,
					canonical_input: { version: 2, exact: "collision" },
				},
				buys: [],
				cohortCreations: [],
			}),
		).rejects.toThrow("algorithm_input_snapshot_collision");

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

	it("retains the filled cost of all 49 canceled pending-fill reservations", async () => {
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
		expect(beforeRelease.activeBuys).toHaveLength(8);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBeCloseTo(
			73.42378,
			5,
		);
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
					reservation.state === "active" &&
					Number(reservation.releasedBudgetUsdc) === 0 &&
					Number(reservation.filledCostUsdc) === 0.1,
			),
		).toBe(true);

		// A later historical cancel likewise remains fail-closed until its market
		// reaches an economically terminal lifecycle.
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
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBeCloseTo(
			74.92378,
			5,
		);
		await db.insert(polyCopyTradeFills).values(
			Array.from({ length: 50 }, (_, index) => ({
				billingAccountId: accountA,
				createdByUserId: ownerA,
				targetId: targetReservationCatchup,
				fillId: `terminal-catchup-fill-${index}`,
				marketId: "prediction-market:polymarket:condition-terminal-catchup",
				observedAt: asOf,
				clientOrderId:
					index < actions.length
						? `terminal-catchup-client-${index}`
						: "terminal-catchup-missing-acquisition-client",
				orderId:
					index < actions.length
						? `terminal-catchup-order-${index}`
						: "terminal-catchup-missing-acquisition-order",
				status: "canceled" as const,
				positionLifecycle: "loser" as const,
				price: "0.1",
				shares: "1",
				attributes: { position_gap_version: "3" },
			})),
		);
		expect(await store.releaseTerminalExposure(scope)).toBe(50);
		expect(await store.releaseTerminalExposure(scope)).toBe(0);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBe(0);
	});

	it("retains canceled fill cost until terminal lifecycle releases it", async () => {
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
			state: "active",
			filledCostUsdc: "2.00000000",
		});
		expect(Number(reservation?.releasedBudgetUsdc)).toBe(3);
		expect(Number(cohort?.acquiredShares)).toBe(4);
		expect(Number(cohort?.remainingShares)).toBe(6);
		expect(Number(cohort?.openOrderShares)).toBe(0);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBe(2);
		const runtime = await store.loadPlannerState(scope);
		expect(runtime.cohorts[0]?.acquiredMirrorShares).toBe(4);
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
		expect(verifiedReservation?.state).toBe("active");
		expect(Number(verifiedReservation?.releasedBudgetUsdc)).toBe(3.19);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBeCloseTo(
			1.81,
		);

		await db
			.update(polyCopyTradeFills)
			.set({ positionLifecycle: "loser" })
			.where(eq(polyCopyTradeFills.clientOrderId, "canceled-receipt-client"));
		expect(await store.releaseTerminalExposure(scope)).toBe(1);
		expect(await store.releaseTerminalExposure(scope)).toBe(0);
		expect((await store.activeReservationTotals(scope)).budgetUsdc).toBe(0);
		const [releasedReservation] = await db
			.select()
			.from(polyPositionGapReservations)
			.where(eq(polyPositionGapReservations.buyActionId, buy.id));
		expect(releasedReservation).toMatchObject({
			state: "released",
			releaseReason: "loser_terminal",
		});
		expect(Number(releasedReservation?.releasedBudgetUsdc)).toBe(5);
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
			lineage: algorithmLineage,
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
			input_snapshot: {
				input_snapshot_id: ledgerSnapshotHash,
				algorithm_id: "poly.copy-mirror.position-gap",
				input_contract_version: "position-gap-book-input-v2",
				canonical_input: { exact: "ledger-pre-dispatch" },
				quality: { validation: "validated" },
			},
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
				lineage: { ...algorithmLineage, input_snapshot_id: ledgerSnapshotHash },
			}),
		});
		const [durableInput] = await db
			.select()
			.from(polyAlgorithmInputSnapshots)
			.where(
				eq(polyAlgorithmInputSnapshots.inputSnapshotId, ledgerSnapshotHash),
			);
		expect(durableInput?.canonicalInput).toEqual({ exact: "ledger-pre-dispatch" });
		await expect(
			ledger.insertPending({
				billing_account_id: accountA,
				created_by_user_id: ownerA,
				target_id: targetAmbiguousRejection,
				fill_id: "position-gap-v3:collision",
				observed_at: asOf,
				input_snapshot: {
					input_snapshot_id: ledgerSnapshotHash,
					algorithm_id: "poly.copy-mirror.position-gap",
					input_contract_version: "position-gap-book-input-v2",
					canonical_input: { exact: "different" },
					quality: { validation: "validated" },
				},
				intent: buildPositionGapBuyIntent({
					marketId: "prediction-market:polymarket:condition-collision",
					outcome: "0",
					notionalUsdc: 1,
					limitPrice: 0.5,
					clientOrderId: "collision-client",
					tokenId: "token-collision",
					conditionId: "condition-collision",
					cohortKey: "collision-cohort",
					targetWallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
					lineage: { ...algorithmLineage, input_snapshot_id: ledgerSnapshotHash },
				}),
			}),
		).rejects.toThrow("algorithm_input_snapshot_collision");
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
		expect(Number(reservation?.releasedBudgetUsdc)).toBe(3);
		expect(reservation?.state).toBe("active");
		expect(
			(
				await store.activeReservationTotals({
					billingAccountId: accountA,
					createdByUserId: ownerA,
					targetId: targetNotFound,
				})
			).budgetUsdc,
		).toBe(2);
		expect(Number(cohort?.acquiredShares)).toBe(4);
		expect(Number(cohort?.openOrderShares)).toBe(0);
		expect(Number(cohort?.remainingShares)).toBe(6);
	});
});
