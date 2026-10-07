// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
	type Fill,
	type LoggerPort,
	noopMetrics,
	type OrderReceipt,
} from "@cogni/poly-market-provider";
import { describe, expect, it, vi } from "vitest";
import { buildMirrorTargetConfig } from "@/bootstrap/jobs/copy-trade-mirror.job";
import { runMirrorTick } from "@/features/copy-trade/mirror-pipeline";
import type {
	OpenOrderRow,
	OrderLedger,
	TenantOrderLedger,
	TenantScopedRecordDecisionInput,
} from "@/features/trading/order-ledger.types";

const buyFill: Fill = {
	target_wallet: "0x2005d16a00000000000000000000000000000000",
	fill_id: "chain:position-gap-vwap",
	source: "chain",
	market_id: "prediction-market:polymarket:condition",
	outcome: "YES",
	side: "BUY",
	price: 0.5064,
	size_usdc: 50,
	observed_at: "2026-10-07T00:00:00.000Z",
	attributes: {
		asset: "token-1",
		condition_id: "condition",
		end_date: "2027-10-07T00:00:00.000Z",
	},
};

const target = buildMirrorTargetConfig({
	targetWallet: buyFill.target_wallet,
	billingAccountId: "billing-1",
	createdByUserId: "user-1",
	sizingPolicyKind: "position_gap",
});

function recordingLogger(entries: Record<string, unknown>[]) {
	const build = (bindings: Record<string, unknown>): LoggerPort => ({
		debug(obj) {
			entries.push({ ...bindings, ...obj });
		},
		info(obj) {
			entries.push({ ...bindings, ...obj });
		},
		warn(obj) {
			entries.push({ ...bindings, ...obj });
		},
		error(obj) {
			entries.push({ ...bindings, ...obj });
		},
		child(childBindings) {
			return build({ ...bindings, ...childBindings });
		},
	});
	return build({});
}

function ledgerHarness(openOrders: OpenOrderRow[] = []) {
	const decisions: TenantScopedRecordDecisionInput[] = [];
	const insertPending = vi.fn(async () => undefined);
	const markOrderId = vi.fn(async () => undefined);
	const markCanceled = vi.fn(async () => undefined);
	const tenant: TenantOrderLedger = {
		snapshotState: async () => ({
			today_spent_usdc: 0,
			fills_last_hour: 0,
			already_placed_ids: [],
			placed_fill_ids: [],
			position_aggregates: [],
		}),
		cumulativeIntentForMarketToken: async () => 0,
		insertPending,
		hasOpenForMarket: async () => false,
		findOpenForMarket: async () => openOrders,
		recordDecision: async (decision) => {
			decisions.push(decision);
		},
	};
	const ledger = {
		forTenant: () => tenant,
		markOrderId,
		markError: async () => undefined,
		markCanceled,
	} as unknown as OrderLedger;
	return { decisions, insertPending, ledger, markCanceled, markOrderId };
}

function commonDeps(fill: Fill, ledger: OrderLedger, logger: LoggerPort) {
	return {
		source: { fetchSince: async () => ({ fills: [fill], newSince: 1 }) },
		ledger,
		placeIntent: vi.fn<() => Promise<OrderReceipt>>(),
		target,
		getCursor: () => undefined,
		setCursor: () => undefined,
		logger,
		metrics: noopMetrics,
		clock: () => new Date("2026-10-07T00:00:01.000Z"),
		getMarketConstraints: async () => ({
			minShares: 1,
			minUsdcNotional: 1,
			tickSize: 0.001,
		}),
		getTargetConditionPosition: async () => ({
			condition_id: "condition",
			tokens: [
				{
					token_id: "token-1",
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
	};
}

describe("position_gap pipeline VWAP boundary", () => {
	it("records every input used by a vwap_floor_breach skip", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(
			buyFill,
			harness.ledger,
			recordingLogger(entries),
		);

		await runMirrorTick(deps);

		expect(deps.placeIntent).not.toHaveBeenCalled();
		expect(harness.insertPending).not.toHaveBeenCalled();
		expect(harness.decisions).toHaveLength(1);
		expect(harness.decisions[0]).toMatchObject({
			outcome: "skipped",
			reason: "vwap_floor_breach",
			intent: {
				target_vwap_for_fill_token: 0.5,
				vwap_tolerance: 0.005,
				fill_price: 0.5064,
				evaluated_limit_price: 0.506,
				sizing_policy_kind: "position_gap",
				position_gap_version: 2,
				mirror_capital_budget_usdc: null,
				effective_mirror_capital_budget_usdc: 100,
				mirror_budget_allocation_status: "full",
				mirror_portfolio_current_value_usdc: 100,
			},
		});
		expect(entries).toContainEqual(
			expect.objectContaining({
				outcome: "skipped",
				reason: "vwap_floor_breach",
				target_vwap_for_fill_token: 0.5,
				vwap_tolerance: 0.005,
				fill_price: 0.5064,
				evaluated_limit_price: 0.506,
				sizing_policy_kind: "position_gap",
				position_gap_version: 2,
				mirror_capital_budget_usdc: null,
				effective_mirror_capital_budget_usdc: 100,
				mirror_budget_allocation_status: "full",
			}),
		);
	});

	it("keeps an overweight position-gap SELL on the close path", async () => {
		const sellFill: Fill = {
			...buyFill,
			fill_id: "chain:position-gap-sell",
			side: "SELL",
			price: 0.5,
		};
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(
			sellFill,
			harness.ledger,
			recordingLogger(entries),
		);
		const closePosition = vi.fn(
			async (params: {
				client_order_id: `0x${string}`;
				max_size_usdc: number;
			}) => ({
				order_id: "sell-order-1",
				client_order_id: params.client_order_id,
				status: "filled" as const,
				filled_size_usdc: params.max_size_usdc,
				fill_price: 0.5,
				total_shares: params.max_size_usdc / 0.5,
				fees_usdc: 0,
				submitted_at: "2026-10-07T00:00:01.000Z",
			}),
		);

		await runMirrorTick({
			...deps,
			getTargetConditionPosition: async () => ({
				condition_id: "condition",
				tokens: [
					{
						token_id: "token-1",
						size_shares: 2,
						cost_usdc: 1,
						current_value_usdc: 1,
					},
				],
			}),
			getOperatorPositions: async () => [{ asset: "token-1", size: 10 }],
			closePosition,
		});

		expect(closePosition).toHaveBeenCalledWith(
			expect.objectContaining({
				tokenId: "token-1",
				max_size_usdc: 4,
				limit_price: 0.5,
			}),
		);
		expect(harness.insertPending).toHaveBeenCalledOnce();
		expect(harness.markOrderId).toHaveBeenCalledOnce();
		expect(harness.decisions).toContainEqual(
			expect.objectContaining({
				outcome: "placed",
				reason: "sell_closed_position",
			}),
		);
		expect(harness.decisions).not.toContainEqual(
			expect.objectContaining({ reason: "vwap_floor_breach" }),
		);
	});

	it.each(["BUY", "SELL"] as const)(
		"fails closed and cancels resting orders for %s with multiple position-gap targets",
		async (side) => {
			const fill: Fill = {
				...buyFill,
				fill_id: `chain:position-gap-multi-${side.toLowerCase()}`,
				side,
			};
			const blockedTarget = buildMirrorTargetConfig({
				targetWallet: fill.target_wallet,
				billingAccountId: "billing-1",
				createdByUserId: "user-1",
				sizingPolicyKind: "position_gap",
				positionGapBudgetGroup: {
					positionGapTargetCount: 2,
					explicitBudgetTotalUsdc: 0,
					automaticTargetCount: 2,
					unbudgetedTargetCount: 0,
				},
			});
			const openOrder: OpenOrderRow = {
				client_order_id: `0x${"1".repeat(64)}`,
				order_id: "resting-order-1",
				status: "open",
				billing_account_id: "billing-1",
				target_id: blockedTarget.target_id,
				market_id: fill.market_id,
				created_at: new Date("2026-10-07T00:00:00.000Z"),
				limit_price: 0.5,
			};
			const entries: Record<string, unknown>[] = [];
			const harness = ledgerHarness([openOrder]);
			const deps = commonDeps(
				fill,
				harness.ledger,
				recordingLogger(entries),
			);
			const cancelOrder = vi.fn(async () => undefined);
			const closePosition = vi.fn(async () => {
				throw new Error("closePosition must not run");
			});
			const getOperatorPositions = vi.fn(async () => [
				{ asset: "token-1", size: 10 },
			]);

			await runMirrorTick({
				...deps,
				target: blockedTarget,
				cancelOrder,
				closePosition,
				getOperatorPositions,
			});

			expect(deps.placeIntent).not.toHaveBeenCalled();
			expect(closePosition).not.toHaveBeenCalled();
			expect(getOperatorPositions).not.toHaveBeenCalled();
			expect(harness.insertPending).not.toHaveBeenCalled();
			expect(cancelOrder).toHaveBeenCalledWith("resting-order-1");
			expect(harness.markCanceled).toHaveBeenCalledWith({
				client_order_id: openOrder.client_order_id,
				reason: "multi_target_position_gap_unsupported",
			});
			expect(harness.decisions).toContainEqual(
				expect.objectContaining({
					outcome: "skipped",
					reason: "multi_target_position_gap_unsupported",
					intent: expect.objectContaining({
						mirror_budget_allocation_status: "blocked_multi_target",
						position_gap_target_count: 2,
					}),
				}),
			);
		},
	);
});
