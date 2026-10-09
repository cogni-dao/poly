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
	const insertPending = vi.fn<() => Promise<"live" | "paper">>(async () =>
		Promise.resolve("paper"),
	);
	const markOrderId = vi.fn(async () => undefined);
	const markError = vi.fn(async () => undefined);
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
		markError,
		markCanceled,
	} as unknown as OrderLedger;
	return {
		decisions,
		insertPending,
		ledger,
		markCanceled,
		markError,
		markOrderId,
	};
}

function commonDeps(fill: Fill, ledger: OrderLedger, logger: LoggerPort) {
	return {
		implementationRevision: "0123456789abcdef0123456789abcdef01234567",
		targetRowId: "target-row-1",
		assignmentId: "target:2026-10-07T00:00:00.000Z",
		isAssignmentCurrent: async () => true,
		source: { fetchSince: async () => ({ fills: [fill], newSince: 1 }) },
		ledger,
		getExecutionMode: async () => "paper" as const,
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

describe("position_gap legacy fill-pipeline boundary", () => {
	it("fails closed before source reads when the assignment is retired", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));
		const fetchSince = vi.fn(deps.source.fetchSince);

		await runMirrorTick({
			...deps,
			source: { fetchSince },
			isAssignmentCurrent: async () => false,
		});

		expect(fetchSince).not.toHaveBeenCalled();
		expect(harness.decisions).toHaveLength(0);
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "poly.mirror.assignment_retired",
				outcome: "skipped",
				reason: "assignment_retired",
				billing_account_id: "billing-1",
				target_row_id: "target-row-1",
				assignment_id: "target:2026-10-07T00:00:00.000Z",
				algorithm_id: "poly.copy-mirror.position-gap",
			}),
		);
		expect(entries[0]).not.toHaveProperty("target_wallet");
	});

	it("reports liveness lookup failure as an error, not known retirement", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));
		const fetchSince = vi.fn(deps.source.fetchSince);

		await runMirrorTick({
			...deps,
			source: { fetchSince },
			isAssignmentCurrent: async () => {
				throw new Error("DB unavailable");
			},
		});

		expect(fetchSince).not.toHaveBeenCalled();
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "poly.mirror.assignment_retired",
				outcome: "error",
				reason: "assignment_liveness_unavailable",
				errorCode: "assignment_liveness_unavailable",
			}),
		);
		expect(entries).not.toContainEqual(
			expect.objectContaining({ reason: "assignment_retired" }),
		);
	});

	it("drops an old planner skip when the assignment retires mid-tick", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));
		const isAssignmentCurrent = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		await runMirrorTick({ ...deps, isAssignmentCurrent });

		expect(isAssignmentCurrent).toHaveBeenCalledTimes(2);
		expect(harness.decisions).toHaveLength(0);
		expect(harness.insertPending).not.toHaveBeenCalled();
		expect(
			entries.filter(
				(entry) => entry.event === "poly.mirror.assignment_retired",
			),
		).toHaveLength(1);
		expect(
			entries.filter((entry) => entry.event === "poly.mirror.decision"),
		).toHaveLength(0);
	});

	it("never cancels shared orders after a SELL assignment retires", async () => {
		const sellFill: Fill = {
			...buyFill,
			fill_id: "chain:retired-sell-cancel",
			side: "SELL",
		};
		const openOrder: OpenOrderRow = {
			client_order_id: `0x${"1".repeat(64)}`,
			order_id: "shared-resting-order",
			status: "open",
			billing_account_id: "billing-1",
			target_id: target.target_id,
			market_id: sellFill.market_id,
			created_at: new Date("2026-10-07T00:00:00.000Z"),
			mode: "paper",
			limit_price: 0.5,
		};
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness([openOrder]);
		const deps = commonDeps(
			sellFill,
			harness.ledger,
			recordingLogger(entries),
		);
		const isAssignmentCurrent = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const cancelOrder = vi.fn(async () => undefined);

		await runMirrorTick({
			...deps,
			isAssignmentCurrent,
			cancelOrder,
		});

		expect(cancelOrder).not.toHaveBeenCalled();
		expect(harness.markCanceled).not.toHaveBeenCalled();
		expect(harness.decisions).toHaveLength(0);
		expect(
			entries.filter(
				(entry) => entry.event === "poly.mirror.assignment_retired",
			),
		).toHaveLength(1);
		expect(
			entries.filter((entry) => entry.event === "poly.mirror.decision"),
		).toHaveLength(0);
	});

	it("adds complete lineage and durable assignment attribution to terminal decisions", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));

		await runMirrorTick(deps);

		const terminal = entries.find(
			(entry) =>
				entry.event === "poly.mirror.decision" && entry.outcome === "skipped",
		);
		expect(terminal).toMatchObject({
			billing_account_id: "billing-1",
			target_row_id: "target-row-1",
			assignment_id: "target:2026-10-07T00:00:00.000Z",
			algorithm_id: "poly.copy-mirror.position-gap",
			algorithm_version_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			config_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			input_snapshot_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			correlation_id: expect.stringMatching(/^0x[a-f0-9]{64}$/),
		});
		expect(terminal).not.toHaveProperty("target_wallet");
	});

	it("retires a pending intent when assignment changes before venue dispatch", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const eligibleFill = { ...buyFill, price: 0.5 };
		const deps = commonDeps(
			eligibleFill,
			harness.ledger,
			recordingLogger(entries),
		);
		const isAssignmentCurrent = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const placeIntent = vi.fn(async () => {
			throw new Error("retired assignment must not reach venue");
		});

		await runMirrorTick({
			...deps,
			isAssignmentCurrent,
			target: buildMirrorTargetConfig({
				targetWallet: eligibleFill.target_wallet,
				billingAccountId: "billing-1",
				createdByUserId: "user-1",
				sizingPolicyKind: "min_bet",
			}),
			placeIntent,
		});

		expect(isAssignmentCurrent).toHaveBeenCalledTimes(2);
		expect(harness.insertPending).toHaveBeenCalledOnce();
		expect(placeIntent).not.toHaveBeenCalled();
		expect(harness.markCanceled).toHaveBeenCalledWith({
			client_order_id: expect.stringMatching(/^0x[a-f0-9]{64}$/),
			reason: "assignment_retired",
		});
		expect(harness.decisions).toContainEqual(
			expect.objectContaining({
				outcome: "skipped",
				reason: "assignment_retired",
			}),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "poly.mirror.assignment_retired",
				outcome: "skipped",
				reason: "assignment_retired",
				algorithm_id: "poly.copy-mirror.min-bet",
				algorithm_version_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
				config_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
				input_snapshot_id: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
				correlation_id: expect.stringMatching(/^0x[a-f0-9]{64}$/),
			}),
		);
	});

	it("does not place when the account venue changes after private facts are read", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		harness.insertPending.mockResolvedValueOnce("live");
		const deps = commonDeps(
			{ ...buyFill, price: 0.5 },
			harness.ledger,
			recordingLogger(entries),
		);
		const placeIntent = vi.fn(async () => {
			throw new Error("venue call must not run");
		});

		await runMirrorTick({
			...deps,
			target: buildMirrorTargetConfig({
				targetWallet: buyFill.target_wallet,
				billingAccountId: "billing-1",
				createdByUserId: "user-1",
				sizingPolicyKind: "min_bet",
			}),
			placeIntent,
		});

		expect(placeIntent).not.toHaveBeenCalled();
		expect(harness.markError).toHaveBeenCalledOnce();
		expect(harness.decisions).toContainEqual(
			expect.objectContaining({
				mode_override: "live",
				outcome: "error",
				reason: "placement_failed",
			}),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				execution_mode: "live",
				outcome: "error",
				reason: "placement_failed",
			}),
		);
	});

	it("retires a pending intent when venue drift and replacement race", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		harness.insertPending.mockResolvedValueOnce("live");
		const deps = commonDeps(
			{ ...buyFill, price: 0.5 },
			harness.ledger,
			recordingLogger(entries),
		);
		const isAssignmentCurrent = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const placeIntent = vi.fn(async () => {
			throw new Error("retired assignment must not reach venue");
		});

		await runMirrorTick({
			...deps,
			isAssignmentCurrent,
			target: buildMirrorTargetConfig({
				targetWallet: buyFill.target_wallet,
				billingAccountId: "billing-1",
				createdByUserId: "user-1",
				sizingPolicyKind: "min_bet",
			}),
			placeIntent,
		});

		expect(isAssignmentCurrent).toHaveBeenCalledTimes(2);
		expect(placeIntent).not.toHaveBeenCalled();
		expect(harness.markError).not.toHaveBeenCalled();
		expect(harness.markCanceled).toHaveBeenCalledWith({
			client_order_id: expect.stringMatching(/^0x[a-f0-9]{64}$/),
			reason: "assignment_retired",
		});
		expect(harness.decisions).toContainEqual(
			expect.objectContaining({
				mode_override: "live",
				outcome: "skipped",
				reason: "assignment_retired",
			}),
		);
		expect(entries).not.toContainEqual(
			expect.objectContaining({ reason: "placement_failed" }),
		);
		expect(
			entries.filter(
				(entry) => entry.event === "poly.mirror.assignment_retired",
			),
		).toHaveLength(1);
	});

	it("fails the legacy fill pipeline closed so the book actor is the only planner", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));

		await runMirrorTick(deps);

		expect(deps.placeIntent).not.toHaveBeenCalled();
		expect(harness.insertPending).not.toHaveBeenCalled();
		expect(harness.decisions).toHaveLength(1);
		expect(harness.decisions[0]).toMatchObject({
			outcome: "skipped",
			reason: "invalid_input",
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
				reason: "invalid_input",
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

	it("records shared mirror facts for min_bet even when target NAV is unavailable", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));
		const minBetTarget = buildMirrorTargetConfig({
			targetWallet: buyFill.target_wallet,
			billingAccountId: "billing-1",
			createdByUserId: "user-1",
			sizingPolicyKind: "min_bet",
		});

		await runMirrorTick({
			...deps,
			target: minBetTarget,
			getTargetPortfolioCurrentValue: async () => {
				throw new Error("target rate limited");
			},
			getMirrorPortfolioSnapshot: async () => ({
				currentValueUsdc: 321,
				positions: [{ asset: "token-1", size: 7, currentValue: 3.5 }],
			}),
		});

		expect(harness.decisions).toHaveLength(1);
		expect(harness.decisions[0]).toMatchObject({
			intent: {
				sizing_policy_kind: "min_bet",
				target_portfolio_current_value_usdc: null,
				mirror_portfolio_current_value_usdc: 321,
				mirror_token_qty_shares: 7,
			},
		});
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "poly.mirror.decision",
				target_portfolio_current_value_usdc: null,
				mirror_portfolio_current_value_usdc: 321,
				mirror_token_qty_shares: 7,
			}),
		);
	});

	it("fails legacy position-gap SELL closed so the book actor remains the only planner", async () => {
		const sellFill: Fill = {
			...buyFill,
			fill_id: "chain:position-gap-sell",
			side: "SELL",
			price: 0.5,
		};
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(sellFill, harness.ledger, recordingLogger(entries));
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

		expect(closePosition).not.toHaveBeenCalled();
		expect(harness.insertPending).not.toHaveBeenCalled();
		expect(harness.markOrderId).not.toHaveBeenCalled();
		expect(harness.decisions).toContainEqual(
			expect.objectContaining({
				outcome: "skipped",
				reason: "invalid_input",
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
				mode: "paper",
				limit_price: 0.5,
			};
			const entries: Record<string, unknown>[] = [];
			const harness = ledgerHarness([openOrder]);
			const deps = commonDeps(fill, harness.ledger, recordingLogger(entries));
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
			expect(cancelOrder).toHaveBeenCalledWith("resting-order-1", "paper");
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
