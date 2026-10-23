// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Actual live/paper authorization over PostgreSQL, never a signing/venue call. */
import { randomUUID } from "node:crypto";
import type { Database } from "@cogni/db-client";
import { getContractConfig } from "@polymarket/clob-client-v2";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import pino from "pino";
import { maxUint256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { PrivyPolyTraderWalletAdapter } from "@/adapters/server/wallet/privy-poly-trader-wallet.adapter";
import { createPaperVenue } from "@/features/paper-accounts/server/paper-venue";
import {
	billingAccounts,
	polyCopyTradeFills,
	polyWalletConnections,
	polyWalletGrants,
	users,
} from "@/shared/db/schema";

type Mode = "live" | "paper";
type Fill = Partial<typeof polyCopyTradeFills.$inferInsert>;
const intent = {
	side: "BUY" as const,
	usdcAmount: 4,
	marketConditionId: "new-market",
};
const denial = {
	source: "executor_authorize_denied",
	reason: "authorize_denied",
	observed_at: "2026-10-01T00:00:00Z",
};
const final = (cost: number | string, orderId = "venue-order") => ({
	source: "venue_get_order",
	order_id: orderId,
	status: "canceled",
	filled_size_usdc: cost,
	fill_evidence:
		cost === 0 ? "explicit_zero_size_matched" : "clob_associated_trades",
	observed_at: "2026-10-01T00:00:00Z",
});
const address = () =>
	`0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}` as const;

/** Uncommitted fixtures cannot be retired by another component file's sweep. */
async function withHarness(
	mode: Mode,
	test: (h: {
		db: Database;
		account: string;
		otherAccount: string;
		seed: (fill?: Fill) => Promise<void>;
		authorize: (usdcAmount?: number) => Promise<{ ok: boolean; reason?: string }>;
	}) => Promise<void>,
	caps: { daily?: number; hourly?: number } = {},
) {
	const rollback = new Error("rollback grant fixtures");
	try {
		await getSeedDb().transaction(async (tx) => {
			const db = tx as unknown as Database;
			const account = randomUUID();
			const otherAccount = randomUUID();
			const user = randomUUID();
			const otherUser = randomUUID();
			await tx.insert(users).values([
				{ id: user, walletAddress: address() },
				{ id: otherUser, walletAddress: address() },
			]);
			await tx.insert(billingAccounts).values([
				{ id: account, ownerUserId: user, balanceCredits: 0n },
				{ id: otherAccount, ownerUserId: otherUser, balanceCredits: 0n },
			]);
			const funder = address();
			const config = getContractConfig(137);
			const [connection] = await tx
				.insert(polyWalletConnections)
				.values({
					billingAccountId: account,
					createdByUserId: user,
					kind: mode === "live" ? "privy_live" : "paper",
					address: funder,
					funderAddress: funder,
					privyWalletId: mode === "live" ? `test-${randomUUID()}` : null,
					clobApiKeyCiphertext: mode === "live" ? Buffer.from("unused") : null,
					encryptionKeyId: mode === "live" ? "unused" : null,
					paperSeedUsdc: mode === "paper" ? "1000" : null,
					custodialConsentAcceptedAt: new Date(),
					custodialConsentActorKind: "user",
					custodialConsentActorId: user,
					tradingApprovalsReadyAt: new Date(),
					allowanceState: {
						kind: "polymarket_pusd_buy_allowances_v1",
						chainId: 137,
						funderAddress: funder,
						tokenAddress: config.collateral,
						verifiedAt: new Date().toISOString(),
						spenders: [
							config.exchangeV2,
							config.negRiskExchangeV2,
							config.negRiskAdapter,
						].map((spender) => ({
							address: spender,
							allowanceAtomic: maxUint256.toString(),
						})),
					},
				})
				.returning({ id: polyWalletConnections.id });
			if (!connection) throw new Error("missing test connection");
			await tx.insert(polyWalletGrants).values({
				billingAccountId: account,
				walletConnectionId: connection.id,
				createdByUserId: user,
				scopes: ["poly:trade:buy", "poly:trade:sell"],
				perOrderUsdcCap: "5",
				dailyUsdcCap: String(caps.daily ?? 10),
				hourlyFillsCap: caps.hourly ?? 100,
			});
			const adapter = new PrivyPolyTraderWalletAdapter({
				serviceDb: db,
				privyClient: {} as never,
				privySigningKey: "unused",
				encryptionKey: Buffer.alloc(32),
				encryptionKeyId: "unused",
				clobCredsFactory: async () => {
					throw new Error("must not mint credentials");
				},
				logger: pino({ enabled: false }),
			});
			// Only signing-context resolution is stubbed. Every connection, grant,
			// daily sum and hourly count above it executes its production SQL.
			const resolve = vi.spyOn(adapter, "resolve").mockResolvedValue({
				account: { address: funder } as never,
				funderAddress: funder,
				connectionId: connection.id,
				clobCreds: { key: "unused", secret: "unused", passphrase: "unused" },
			});
			const venue =
				mode === "live"
					? adapter
					: createPaperVenue({
							db: db as unknown as PostgresJsDatabase<Record<string, unknown>>,
						});
			try {
				await test({
					db,
					account,
					otherAccount,
					authorize: (usdcAmount = intent.usdcAmount) =>
						venue.authorizeIntent(account, { ...intent, usdcAmount }),
					async seed(fill = {}) {
						await tx.insert(polyCopyTradeFills).values({
							billingAccountId: account,
							createdByUserId:
								fill.billingAccountId === otherAccount ? otherUser : user,
							targetId: randomUUID(),
							fillId: randomUUID(),
							clientOrderId: randomUUID(),
							marketId: randomUUID(),
							mode,
							status: "pending",
							observedAt: new Date("2020-01-01T00:00:00Z"),
							attributes: { size_usdc: 4, token_id: randomUUID() },
							...fill,
						});
					},
				});
			} finally {
				resolve.mockRestore();
			}
			// Includes deliberate PostgreSQL cast failures: roll back rather than
			// trying to commit/clean up an aborted transaction or leave fixtures.
			throw rollback;
		});
	} catch (err) {
		if (err !== rollback) throw err;
	}
}

describe.each(["live", "paper"] as const)(
	"%s grant commitment windows (PostgreSQL)",
	(mode) => {
		it.each([
			["accepted error", { status: "error", orderId: "venue-order" }, true],
			["ambiguous no-ID error", { status: "error" }, true],
			[
				"partial keeps full commitment",
				{
					status: "partial",
					attributes: { size_usdc: 4, filled_size_usdc: 1 },
				},
				true,
			],
			[
				"accepted cost exceeds intention",
				{ status: "filled", attributes: { size_usdc: 1, filled_size_usdc: 4 } },
				true,
			],
			[
				"unproved canceled zero",
				{
					status: "canceled",
					attributes: { size_usdc: 4, filled_size_usdc: 0 },
				},
				true,
			],
			[
				"unproved canceled positive",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: { size_usdc: 4, filled_size_usdc: 1 },
				},
				true,
			],
			[
				"definite denial",
				{
					status: "error",
					attributes: { size_usdc: 4, non_execution_proof: denial },
				},
				false,
			],
			[
				"known order contradicts denial",
				{
					status: "error",
					orderId: "venue-order",
					attributes: { size_usdc: 4, non_execution_proof: denial },
				},
				true,
			],
			[
				"positive shares contradict denial",
				{
					status: "error",
					shares: "2",
					attributes: { size_usdc: 4, non_execution_proof: denial },
				},
				true,
			],
			[
				"proven canceled positive",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: {
						size_usdc: 4,
						filled_size_usdc: 1,
						final_order_observation: final(1),
					},
				},
				false,
			],
			[
				"proven canceled zero",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: { size_usdc: 4, final_order_observation: final(0) },
				},
				false,
			],
			[
				"positive cost contradicts zero",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: {
						size_usdc: 4,
						filled_size_usdc: 3,
						final_order_observation: final(0),
					},
				},
				true,
			],
			[
				"wrong final order identity",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: {
						size_usdc: 4,
						final_order_observation: final(0, "different-order"),
					},
				},
				true,
			],
			[
				"closed execution still spent",
				{
					status: "filled",
					positionLifecycle: "closed",
					attributes: {
						size_usdc: 4,
						filled_size_usdc: 4,
						closed_at: "2026-10-01T00:00:00Z",
					},
				},
				true,
			],
			[
				"redeemed execution still spent",
				{
					status: "filled",
					positionLifecycle: "redeemed",
					attributes: { size_usdc: 4, filled_size_usdc: 4 },
				},
				true,
			],
		] satisfies [string, Fill, boolean][])(
			"daily: %s",
			async (_name, fill, denies) => {
				await withHarness(mode, async ({ seed, authorize }) => {
					await seed(); // Existing commitment 4 + new intent 4 leaves exactly 2.
					await seed(fill);
					const result = await authorize();
					expect(result.ok).toBe(!denies);
					if (denies) expect(result.reason).toBe("cap_exceeded_daily");
				});
			},
		);

		it.each([
			["accepted error", { status: "error", orderId: "venue-order" }, true],
			["ambiguous error", { status: "error" }, true],
			[
				"unproved canceled zero",
				{
					status: "canceled",
					attributes: { size_usdc: 4, filled_size_usdc: 0 },
				},
				true,
			],
			[
				"final canceled positive",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: {
						size_usdc: 4,
						filled_size_usdc: 1,
						final_order_observation: final(1),
					},
				},
				true,
			],
			[
				"definite nonexecution",
				{
					status: "error",
					attributes: { size_usdc: 4, non_execution_proof: denial },
				},
				false,
			],
			[
				"proven final zero",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: { size_usdc: 4, final_order_observation: final(0) },
				},
				false,
			],
		] satisfies [string, Fill, boolean][])(
			"hourly: %s",
			async (_name, fill, denies) => {
				await withHarness(
					mode,
					async ({ seed, authorize }) => {
						await seed(fill);
						const result = await authorize();
						expect(result.ok).toBe(!denies);
						if (denies) expect(result.reason).toBe("cap_exceeded_hourly_fills");
					},
					{ daily: 100, hourly: 1 },
				);
			},
		);

		it.each([
			[
				"zero intended with known order and shares",
				{
					status: "open",
					orderId: "venue-order",
					shares: "2",
					attributes: { size_usdc: 0 },
				},
				"backend_unreachable",
			],
			[
				"zero intended with known order",
				{
					status: "open",
					orderId: "venue-order",
					attributes: { size_usdc: 0 },
				},
				"backend_unreachable",
			],
			[
				"zero intended with no ID and positive shares",
				{ shares: "2", attributes: { size_usdc: 0 } },
				"backend_unreachable",
			],
			[
				"zero intended without execution authority",
				{ attributes: { size_usdc: 0, filled_size_usdc: 0 } },
				"backend_unreachable",
			],
			[
				"known order contradicts zero-intent denial",
				{
					status: "error",
					orderId: "venue-order",
					attributes: { size_usdc: 0, non_execution_proof: denial },
				},
				"backend_unreachable",
			],
			[
				"positive shares contradict zero-intent denial",
				{
					status: "error",
					shares: "2",
					attributes: { size_usdc: 0, non_execution_proof: denial },
				},
				"backend_unreachable",
			],
			[
				"wrong order contradicts zero-intent final release",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: {
						size_usdc: 0,
						final_order_observation: final(0, "different-order"),
					},
				},
				"backend_unreachable",
			],
			[
				"positive shares contradict zero-intent final release",
				{
					status: "canceled",
					orderId: "venue-order",
					shares: "2",
					attributes: { size_usdc: 0, final_order_observation: final(0) },
				},
				"backend_unreachable",
			],
			[
				"zero-intent authenticated denial releases",
				{
					status: "error",
					attributes: { size_usdc: 0, non_execution_proof: denial },
				},
				undefined,
			],
			[
				"zero-intent pre-dispatch retirement releases",
				{
					status: "canceled",
					attributes: {
						size_usdc: 0,
						non_execution_proof: {
							...denial,
							source: "pre_dispatch_retirement",
						},
					},
				},
				undefined,
			],
			[
				"zero-intent authenticated final zero releases",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: { size_usdc: 0, final_order_observation: final(0) },
				},
				undefined,
			],
			[
				"zero-intent accepted spend remains committed",
				{
					status: "open",
					orderId: "venue-order",
					attributes: { size_usdc: 0, filled_size_usdc: 2 },
				},
				"cap_exceeded_hourly_fills",
			],
			[
				"zero-intent accepted spend contradicts final zero",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: {
						size_usdc: 0,
						filled_size_usdc: 2,
						final_order_observation: final(0),
					},
				},
				"cap_exceeded_hourly_fills",
			],
			[
				"zero-intent authenticated final spend remains committed",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: { size_usdc: 0, final_order_observation: final(2) },
				},
				"cap_exceeded_hourly_fills",
			],
			[
				"positive-intent known order remains committed",
				{
					status: "open",
					orderId: "venue-order",
					shares: "2",
					attributes: { size_usdc: 4 },
				},
				"cap_exceeded_hourly_fills",
			],
			[
				"positive-intent authenticated denial releases",
				{
					status: "error",
					attributes: { size_usdc: 4, non_execution_proof: denial },
				},
				undefined,
			],
			[
				"positive-intent authenticated final zero releases",
				{
					status: "canceled",
					orderId: "venue-order",
					attributes: { size_usdc: 4, final_order_observation: final(0) },
				},
				undefined,
			],
		] satisfies [string, Fill, string | undefined][])(
			"zero commitment guard: %s",
			async (_name, fill, reason) => {
				await withHarness(
					mode,
					async ({ seed, authorize }) => {
						await seed(fill);
						const result = await authorize();
						expect(result.ok).toBe(reason === undefined);
						if (reason) expect(result.reason).toBe(reason);
					},
					{ daily: 100, hourly: 1 },
				);
			},
		);

		it("keeps other account, other mode and old creation time outside both windows", async () => {
			await withHarness(
				mode,
				async ({ seed, authorize, otherAccount }) => {
					await seed({
						billingAccountId: otherAccount,
						attributes: { size_usdc: 100 },
					});
					await seed({
						mode: mode === "live" ? "paper" : "live",
						attributes: { size_usdc: 100 },
					});
					await seed({
						createdAt: new Date("2020-01-01T00:00:00Z"),
						observedAt: new Date(),
						attributes: { size_usdc: 100 },
					});
					expect((await authorize()).ok).toBe(true);
				},
				{ hourly: 1 },
			);
		});

		it("charges a recently created intent despite an old upstream observation", async () => {
			await withHarness(mode, async ({ seed, authorize }) => {
				await seed({ status: "error", attributes: { size_usdc: 8 } });
				expect(await authorize()).toMatchObject({
					ok: false,
					reason: "cap_exceeded_daily",
				});
			});
		});

		it.each([
			["24 hours", "cap_exceeded_daily", { daily: 10, hourly: 100 }],
			["1 hour", "cap_exceeded_hourly_fills", { daily: 100, hourly: 1 }],
		] as const)(
			"preserves the inclusive %s creation boundary",
			async (window, reason, caps) => {
				await withHarness(
					mode,
					async ({ db, account, seed, authorize }) => {
						await seed({ status: "error", attributes: { size_usdc: 8 } });
						await db
							.update(polyCopyTradeFills)
							.set({
								createdAt: sql`now() - ${window}::interval`,
							})
							.where(eq(polyCopyTradeFills.billingAccountId, account));
						expect(await authorize()).toMatchObject({ ok: false, reason });
						await db
							.update(polyCopyTradeFills)
							.set({
								createdAt: sql`now() - ${window}::interval - interval '1 microsecond'`,
							})
							.where(eq(polyCopyTradeFills.billingAccountId, account));
						expect((await authorize()).ok).toBe(true);
					},
					caps,
				);
			},
		);

		it("preserves daily equality and the existing additional current-intent check", async () => {
			await withHarness(mode, async ({ seed, authorize }) => {
				await seed({ attributes: { size_usdc: 6 } }); // 6 + intent 4 == cap 10.
				expect((await authorize()).ok).toBe(true);
				await seed(); // Already-ledgered current intent is still counted + added.
				expect(await authorize()).toMatchObject({
					ok: false,
					reason: "cap_exceeded_daily",
				});
			});
		});

		it.each([
			["missing intended", { filled_size_usdc: 1 }],
			["null intended", { size_usdc: null, filled_size_usdc: 1 }],
			["negative intended", { size_usdc: -1 }],
			["nonnumeric intended", { size_usdc: "invalid" }],
			["NaN intended", { size_usdc: "NaN" }],
			["infinite intended", { size_usdc: "Infinity" }],
			["overflowing aggregate", { size_usdc: "1e999" }],
			["negative accepted", { size_usdc: 4, filled_size_usdc: -1 }],
			["NaN accepted", { size_usdc: 4, filled_size_usdc: "NaN" }],
			["infinite accepted", { size_usdc: 4, filled_size_usdc: "Infinity" }],
			["missing intent with release proof", { non_execution_proof: denial }],
			[
				"NaN final execution",
				{ size_usdc: 4, final_order_observation: final("NaN") },
			],
		] satisfies [string, Record<string, unknown>][])(
			"fails closed: %s",
			async (_name, attributes) => {
				await withHarness(mode, async ({ seed, authorize }) => {
					await seed({
						status: "canceled",
						orderId: attributes.non_execution_proof ? null : "venue-order",
						attributes,
					});
					expect(await authorize()).toMatchObject({
						ok: false,
						reason: "backend_unreachable",
					});
				});
			},
		);

		it("denies an actual PostgreSQL read failure", async () => {
			await withHarness(mode, async ({ db, authorize }) => {
				// Real relation-resolution error, scoped to this rolled-back test only.
				await db.execute(sql`SET LOCAL search_path = pg_catalog`);
				expect(await authorize()).toMatchObject({
					ok: false,
					reason: "backend_unreachable",
				});
			});
		});

		it.each([
			["NaN", "backend_unreachable"],
			["10", "cap_exceeded_per_order"],
		] as const)(
			"checks cap finiteness before per-order denial (daily %s)",
			async (dailyUsdcCap, reason) => {
				await withHarness(mode, async ({ db, account, authorize }) => {
					await db
						.update(polyWalletGrants)
						.set({ perOrderUsdcCap: "5", dailyUsdcCap })
						.where(eq(polyWalletGrants.billingAccountId, account));
					expect(await authorize(6)).toMatchObject({ ok: false, reason });
				});
			},
		);

		it.each(["5", "NaN"])(
			"denies persisted NaN caps (per-order %s)",
			async (perOrderUsdcCap) => {
				await withHarness(mode, async ({ db, account, authorize }) => {
					// PostgreSQL numeric NaN passes a >0 CHECK; do not trust JS comparisons.
					await db
						.update(polyWalletGrants)
						.set({
							perOrderUsdcCap,
							dailyUsdcCap: "NaN",
						})
						.where(eq(polyWalletGrants.billingAccountId, account));
					expect(await authorize()).toMatchObject({
						ok: false,
						reason: "backend_unreachable",
					});
				});
			},
		);
	},
);
