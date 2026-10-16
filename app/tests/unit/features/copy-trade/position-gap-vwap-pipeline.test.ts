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
import { createOrderLedger } from "@/features/trading/order-ledger";
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

const minBetTarget = buildMirrorTargetConfig({
	targetWallet: buyFill.target_wallet,
	billingAccountId: "billing-1",
	createdByUserId: "user-1",
	sizingPolicyKind: "min_bet",
});

const expiredFill: Fill = {
	...buyFill,
	attributes: { ...buyFill.attributes, end_date: "2026-10-06T00:00:00.000Z" },
};

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
	// Use the actual persistence guard, with only the database writer stubbed.
	// Every pipeline decision retains its real canonical token-bearing snapshot.
	const writes: Record<string, unknown>[] = [];
	const decisionLedger = createOrderLedger({
		db: {
			insert: () => ({
				values: (value: Record<string, unknown>) => {
					writes.push(value);
					return { onConflictDoNothing: async () => undefined };
				},
			}),
			select: () => ({
				from: () => ({
					where: () => ({ limit: async () => [{}] }),
				}),
			}),
		} as unknown as Parameters<typeof createOrderLedger>[0]["db"],
		logger: recordingLogger([]) as unknown as Parameters<
			typeof createOrderLedger
		>[0]["logger"],
		resolveExecutionMode: async () => "paper",
	});
	const insertPending = vi.fn<TenantOrderLedger["insertPending"]>(async () =>
		Promise.resolve("paper"),
	);
	const markOrderId = vi.fn(async () => undefined);
	const markError = vi.fn(async () => undefined);
	const markCanceled = vi.fn(async () => undefined);
	const updateStatus = vi.fn(async () => undefined);
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
			await decisionLedger.recordDecision({
				...decision,
				billing_account_id: "billing-1",
				created_by_user_id: "user-1",
			});
			decisions.push(decision);
		},
	};
	const ledger = {
		forTenant: () => tenant,
		markOrderId,
		markError,
		markCanceled,
		updateStatus,
	} as unknown as OrderLedger;
	return {
		decisions,
		decisionLedger,
		insertPending,
		ledger,
		markCanceled,
		markError,
		markOrderId,
		updateStatus,
		tenant,
		writes,
	};
}

function commonDeps(
	fill: Fill,
	ledger: OrderLedger,
	logger: LoggerPort,
	mirrorTarget = target,
) {
	return {
		implementationRevision: "0123456789abcdef0123456789abcdef01234567",
		targetRowId: "target-row-1",
		assignmentId: "target:2026-10-07T00:00:00.000Z",
		isAssignmentCurrent: async () => true,
		source: { fetchSince: async () => ({ fills: [fill], newSince: 1 }) },
		ledger,
		getExecutionMode: async () => "paper" as const,
		placeIntent: vi.fn<() => Promise<OrderReceipt>>(),
		target: mirrorTarget,
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
	it("persists a skipped fill with the exact token and condition through the real ledger guard", async () => {
		const harness = ledgerHarness();
		await runMirrorTick(
			commonDeps(
				expiredFill,
				harness.ledger,
				recordingLogger([]),
				minBetTarget,
			),
		);

		expect(harness.decisions).toHaveLength(1);
		expect(harness.decisions[0]).toMatchObject({
			outcome: "skipped",
			reason: "market_past_end_date",
			intent: {
				market_id: buyFill.market_id,
				token_id: "token-1",
				condition_id: "condition",
			},
			input_snapshot: { canonical_input: { fill: expiredFill } },
		});
		expect(harness.writes).toContainEqual(
			expect.objectContaining({ outcome: "skipped", mode: "paper" }),
		);
	});

	it("keeps true token mismatches fail closed before any database write", async () => {
		const harness = ledgerHarness();
		await runMirrorTick(
			commonDeps(
				expiredFill,
				harness.ledger,
				recordingLogger([]),
				minBetTarget,
			),
		);
		const decision = harness.decisions[0];
		if (!decision) throw new Error("Expected canonical skipped decision");
		const writesBefore = harness.writes.length;

		await expect(
			harness.decisionLedger.recordDecision({
				...decision,
				billing_account_id: "billing-1",
				created_by_user_id: "user-1",
				intent: { ...decision.intent, token_id: "wrong-token" },
			}),
		).rejects.toThrow("lineage_identity_ambiguous");
		expect(harness.writes).toHaveLength(writesBefore);
	});

	it("persists an insertion error with canonical identity and never places", async () => {
		const harness = ledgerHarness();
		harness.insertPending.mockRejectedValueOnce(
			new Error("insert unavailable"),
		);
		const deps = commonDeps(
			{ ...buyFill, price: 0.5 },
			harness.ledger,
			recordingLogger([]),
		);

		await runMirrorTick({
			...deps,
			target: buildMirrorTargetConfig({
				targetWallet: buyFill.target_wallet,
				billingAccountId: "billing-1",
				createdByUserId: "user-1",
				sizingPolicyKind: "min_bet",
			}),
		});

		expect(deps.placeIntent).not.toHaveBeenCalled();
		expect(harness.decisions).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: "pending_insert_failed",
				intent: expect.objectContaining({
					token_id: "token-1",
					condition_id: "condition",
				}),
			}),
		);
	});

	it("places a ready fill only after insertion and persists its canonical audit", async () => {
		const harness = ledgerHarness();
		const deps = commonDeps(
			{ ...buyFill, price: 0.5 },
			harness.ledger,
			recordingLogger([]),
			minBetTarget,
		);
		const placeIntent = vi.fn(async (intent: { client_order_id: string }) => ({
			order_id: "ready-order",
			client_order_id: intent.client_order_id,
			status: "open" as const,
			filled_size_usdc: 0,
			submitted_at: "2026-10-07T00:00:01.000Z",
		}));

		await runMirrorTick({ ...deps, placeIntent });

		expect(harness.insertPending).toHaveBeenCalledOnce();
		expect(placeIntent).toHaveBeenCalledOnce();
		expect(harness.insertPending.mock.invocationCallOrder[0]).toBeLessThan(
			placeIntent.mock.invocationCallOrder[0] ?? 0,
		);
		expect(harness.decisions).toContainEqual(
			expect.objectContaining({
				outcome: "placed",
				intent: expect.objectContaining({
					token_id: "token-1",
					condition_id: "condition",
				}),
			}),
		);
	});

	it("logs a failed audit and continues subsequent fills without replay or placement", async () => {
		const harness = ledgerHarness();
		const entries: Record<string, unknown>[] = [];
		const recordDecision = harness.tenant.recordDecision;
		harness.tenant.recordDecision = async (decision) =>
			recordDecision(
				decision.fill_id === expiredFill.fill_id
					? {
							...decision,
							intent: { ...decision.intent, token_id: "wrong-token" },
						}
					: decision,
			);
		const nextFill = { ...expiredFill, fill_id: "chain:next-fill" };
		const deps = commonDeps(
			expiredFill,
			harness.ledger,
			recordingLogger(entries),
			minBetTarget,
		);
		const setCursor = vi.fn();

		await runMirrorTick({
			...deps,
			source: {
				fetchSince: async () => ({
					fills: [expiredFill, nextFill],
					newSince: 2,
				}),
			},
			setCursor,
		});

		expect(harness.decisions).toHaveLength(1);
		expect(harness.decisions[0]?.fill_id).toBe(nextFill.fill_id);
		expect(setCursor).toHaveBeenCalledOnce();
		expect(setCursor).toHaveBeenCalledWith(2);
		expect(deps.placeIntent).not.toHaveBeenCalled();
		expect(entries).toContainEqual(
			expect.objectContaining({
				event: "poly.mirror.poll.tick_error",
				errorCode: "fill_processing_failed",
				fill_id: buyFill.fill_id,
				err: "lineage_identity_ambiguous",
				assignment_id: deps.assignmentId,
			}),
		);
		expect(entries).not.toContainEqual(
			expect.objectContaining({
				fill_id: buyFill.fill_id,
				outcome: "skipped",
			}),
		);
	});

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

	it("suppresses an old execution-mode error when the assignment retires", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));
		const fetchSince = vi.fn(deps.source.fetchSince);
		const isAssignmentCurrent = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		await runMirrorTick({
			...deps,
			source: { fetchSince },
			isAssignmentCurrent,
			getExecutionMode: async () => {
				throw new Error("mode unavailable");
			},
		});

		expect(isAssignmentCurrent).toHaveBeenCalledTimes(2);
		expect(fetchSince).not.toHaveBeenCalled();
		expect(
			entries.filter(
				(entry) => entry.event === "poly.mirror.assignment_retired",
			),
		).toHaveLength(1);
		expect(
			entries.filter((entry) => entry.event === "poly.mirror.decision"),
		).toHaveLength(0);
	});

	it("suppresses an old source error when the assignment retires", async () => {
		const entries: Record<string, unknown>[] = [];
		const harness = ledgerHarness();
		const deps = commonDeps(buyFill, harness.ledger, recordingLogger(entries));
		const fetchSince = vi.fn(async () => {
			throw new Error("source unavailable");
		});
		const isAssignmentCurrent = vi
			.fn<() => Promise<boolean>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		await runMirrorTick({
			...deps,
			source: { fetchSince },
			isAssignmentCurrent,
		});

		expect(isAssignmentCurrent).toHaveBeenCalledTimes(2);
		expect(fetchSince).toHaveBeenCalledOnce();
		expect(
			entries.filter(
				(entry) => entry.event === "poly.mirror.assignment_retired",
			),
		).toHaveLength(1);
		expect(
			entries.filter((entry) => entry.event === "poly.mirror.source_error"),
		).toHaveLength(0);
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
		const deps = commonDeps(sellFill, harness.ledger, recordingLogger(entries));
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
		expect(harness.markError).toHaveBeenCalledWith(
			expect.objectContaining({
				non_execution_proof: expect.objectContaining({
					source: "pre_dispatch_retirement",
					reason: "assignment_retired",
				}),
			}),
		);
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

describe("accepted execution survives secondary failures (bug.5042)", () => {
	it.each(["audit", "receipt-persistence"] as const)(
		"%s failure retains reservation and blocks a distinct next fill",
		async (failure) => {
			const h = ledgerHarness();
			const logs: Record<string, unknown>[] = [];
			let reserved = 0;
			h.tenant.cumulativeIntentForMarketToken = async () => reserved;
			h.insertPending.mockImplementation(async (input) => {
				reserved += input.intent.size_usdc;
				return "paper";
			});
			const record = h.tenant.recordDecision;
			h.tenant.recordDecision = async (input) => {
				if (failure === "audit" && input.outcome === "placed")
					throw new Error("lineage audit failed");
				await record(input);
			};
			if (failure === "receipt-persistence") {
				h.markOrderId.mockRejectedValue(
					new Error("DB acknowledgement unavailable"),
				);
				h.updateStatus.mockRejectedValue(new Error("DB still unavailable"));
			}
			const fill = { ...buyFill, price: 0.5 };
			const second = { ...fill, fill_id: "chain:distinct-next-fill" };
			const capped = {
				...minBetTarget,
				sizing: { kind: "min_bet" as const, max_usdc_per_condition: 1 },
			};
			const deps = commonDeps(fill, h.ledger, recordingLogger(logs), capped);
			const placeIntent = vi.fn(
				async (intent: { client_order_id: string }) => ({
					order_id: "accepted-order",
					client_order_id: intent.client_order_id,
					status: "open" as const,
					filled_size_usdc: 0,
					submitted_at: fill.observed_at,
				}),
			);
			await runMirrorTick({
				...deps,
				placeIntent,
				source: {
					fetchSince: async () => ({ fills: [fill, second], newSince: 2 }),
				},
			});
			expect(placeIntent).toHaveBeenCalledOnce();
			expect(h.insertPending).toHaveBeenCalledOnce();
			expect(reserved).toBe(1);
			expect(h.markError).not.toHaveBeenCalled();
			expect(h.decisions).toContainEqual(
				expect.objectContaining({
					fill_id: second.fill_id,
					outcome: "skipped",
					reason: "position_cap_reached",
				}),
			);
			expect(logs).toContainEqual(
				expect.objectContaining({
					outcome: "placed",
					order_id: "accepted-order",
				}),
			);
			expect(logs).toContainEqual(
				expect.objectContaining({
					errorCode:
						failure === "audit"
							? "placement_audit_failed"
							: "receipt_persistence_failed",
				}),
			);
			expect(logs).not.toContainEqual(
				expect.objectContaining({ reason: "placement_failed" }),
			);
		},
	);

	it("retries receipt persistence through updateStatus without a second PLACE", async () => {
		const h = ledgerHarness();
		h.markOrderId.mockRejectedValue(new Error("DB race"));
		const fill = { ...buyFill, price: 0.5 };
		const deps = commonDeps(fill, h.ledger, recordingLogger([]), minBetTarget);
		const placeIntent = vi.fn(async (intent: { client_order_id: string }) => ({
			order_id: "known-order",
			client_order_id: intent.client_order_id,
			status: "partial" as const,
			filled_size_usdc: 1,
			fill_price: 0.5,
			total_shares: 2,
			submitted_at: fill.observed_at,
		}));
		await runMirrorTick({ ...deps, placeIntent });
		expect(placeIntent).toHaveBeenCalledOnce();
		expect(h.updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				order_id: "known-order",
				status: "partial",
				filled_size_usdc: 1,
        realized_fill_source: "paper_order_receipt",
			}),
		);
		expect(h.markError).not.toHaveBeenCalled();
	});

	it.each([true, false])(
		"only definite preflight denial=%s records nonexecution proof",
		async (denied) => {
			const h = ledgerHarness();
			const deps = commonDeps(
				{ ...buyFill, price: 0.5 },
				h.ledger,
				recordingLogger([]),
				minBetTarget,
			);
			const error = Object.assign(
				new Error(denied ? "not authorized" : "post-dispatch timeout"),
				denied
					? {
							details: {
								error_class: "PolyTradeExecutorError",
								error_code: "authorize_denied",
								reason: "cap_exceeded_per_order",
							},
						}
					: {},
			);
			await runMirrorTick({
				...deps,
				placeIntent: vi.fn(async () => {
					throw error;
				}),
			});
			expect(h.markError).toHaveBeenCalledOnce();
			const call = h.markError.mock.calls[0] as unknown as [
				Record<string, unknown>,
			];
			if (denied)
				expect(call[0].non_execution_proof).toMatchObject({
					source: "executor_authorize_denied",
				});
			else expect(call[0].non_execution_proof).toBeUndefined();
		},
	);

	it("risk SELECT failure forbids PLACE even after snapshot fallback returns empty facts", async () => {
		const h = ledgerHarness();
		const riskSelect = vi.fn(() => {
					throw new Error("risk SELECT unavailable");
		});
    const risk = createOrderLedger({
      db: { select: riskSelect } as unknown as Parameters<typeof createOrderLedger>[0]["db"],
      logger: recordingLogger([]) as unknown as Parameters<typeof createOrderLedger>[0]["logger"],
      resolveExecutionMode: async () => "paper",
    });
		h.tenant.cumulativeIntentForMarketToken = (market, token) =>
			risk.cumulativeIntentForMarketToken("billing-1", market, token);
		const deps = commonDeps(
			{ ...buyFill, price: 0.5 },
			h.ledger,
			recordingLogger([]),
			minBetTarget,
		);
		await runMirrorTick(deps);
    expect(riskSelect).toHaveBeenCalledOnce();
		expect(deps.placeIntent).not.toHaveBeenCalled();
		expect(h.insertPending).not.toHaveBeenCalled();
		expect(h.decisions).toContainEqual(
			expect.objectContaining({
				outcome: "skipped",
				reason: "invalid_input",
			}),
		);
	});
});
