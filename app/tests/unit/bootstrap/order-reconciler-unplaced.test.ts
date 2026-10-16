// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Recovery reads may repair accepted orders, never infer nonexecution or PLACE. */
import { describe, expect, it, vi } from "vitest";
import type { OrderReconcilerDeps } from "@/bootstrap/jobs/order-reconciler.job";
import { runReconcileOnce } from "@/bootstrap/jobs/order-reconciler.job";
import type { LedgerRow } from "@/features/trading/order-ledger.types";

const NOW = new Date("2026-10-16T00:00:00Z");
function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
		target_id: "target",
		fill_id: "fill",
		observed_at: NOW,
    client_order_id: "coid-1",
    billing_account_id: "acct-1",
    order_id: null,
    status: "pending",
		position_lifecycle: null,
    mode: "live",
		created_at: new Date("2020-01-01"),
		updated_at: new Date("2020-01-01"),
		synced_at: null,
		attributes: { size_usdc: 5 },
		...overrides,
	};
}
function harness(rows: LedgerRow[], getOrder = vi.fn()) {
	const updateStatus = vi.fn(async () => {});
	const markSynced = vi.fn(async () => {});
	const markReconcileAttempted = vi.fn(async () => {});
	const leaf = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
	const place = vi.fn();
	const deps = {
		ledger: {
			listOpenOrPending: async () => rows,
			updateStatus,
			markSynced,
			markReconcileAttempted,
			insertPending: place,
		},
		getOrderForTenant: getOrder,
		logger: { ...leaf, child: () => leaf },
		metrics: { incr: vi.fn(), observe: vi.fn() },
		notFoundGraceMs: 1,
		clock: () => NOW,
	} as unknown as OrderReconcilerDeps;
	return {
		deps,
		updateStatus,
		markSynced,
		markReconcileAttempted,
		getOrder,
		place,
	};
}
function receipt(overrides: Record<string, unknown> = {}) {
	return {
		order_id: "venue-1",
		client_order_id: "coid-1",
		status: "filled",
		filled_size_usdc: 2,
		fill_price: 0.5,
		total_shares: 4,
		submitted_at: NOW.toISOString(),
		attributes: { realizedFillSource: "clob_associated_trades" },
    ...overrides,
  };
}

describe("read-only conservative order recovery", () => {
	it.each(["live", "paper"] as const)(
		"never terminalizes old unknown-ID %s execution",
		async (mode) => {
			const h = harness([row({ mode })]);
    await runReconcileOnce(h.deps);
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.getOrder).not.toHaveBeenCalled();
			expect(h.markSynced).toHaveBeenCalledWith([]);
			expect(h.markReconcileAttempted).toHaveBeenCalledWith(["coid-1"]);
			expect(h.place).not.toHaveBeenCalled();
		},
	);
	it("does not release old not_found orders, but records the typed read", async () => {
		const h = harness(
			[row({ order_id: "venue-1" })],
			vi.fn(async () => ({ status: "not_found" })),
		);
    await runReconcileOnce(h.deps);
    expect(h.updateStatus).not.toHaveBeenCalled();
		expect(h.markSynced).toHaveBeenCalledWith(["coid-1"]);
		expect(h.markReconcileAttempted).toHaveBeenCalledWith(["coid-1"]);
  });
	it.each(["error", "partial"] as const)(
		"repairs %s from an exact authenticated order read",
		async (status) => {
			const h = harness(
				[row({ order_id: "venue-1", status, mode: "paper" })],
				vi.fn(async () => ({ found: receipt() })),
			);
    await runReconcileOnce(h.deps);
			expect(h.getOrder).toHaveBeenCalledWith("acct-1", "venue-1", "paper");
			expect(h.updateStatus).toHaveBeenCalledWith(
				expect.objectContaining({
      client_order_id: "coid-1",
					order_id: "venue-1",
					status: "filled",
					filled_size_usdc: 2,
					total_shares: 4,
					realized_fill_source: "clob_associated_trades",
				}),
			);
			expect(h.place).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, "", "  ", "invalid", "2", 2])(
		"unavailable realized zero with sizeMatched=%s never releases intent",
		async (sizeMatched) => {
			const h = harness(
				[row({ order_id: "venue-1", status: "canceled" })],
				vi.fn(async () => ({
					found: receipt({
						status: "canceled",
						filled_size_usdc: 0,
						fill_price: undefined,
						total_shares: undefined,
						attributes: { sizeMatched, realizedFillSource: "unavailable" },
					}),
				})),
			);
			await runReconcileOnce(h.deps);
			for (const [update] of h.updateStatus.mock.calls as unknown as Array<
				[Record<string, unknown>]
			>)
				expect(update.final_order_observation).toBeUndefined();
		},
	);
	it.each([0, "0"])(
		"explicit final zero sizeMatched=%s records independent zero proof",
		async (sizeMatched) => {
			const h = harness(
				[row({ order_id: "venue-1", status: "canceled" })],
				vi.fn(async () => ({
					found: receipt({
						status: "canceled",
						filled_size_usdc: 0,
						fill_price: undefined,
						total_shares: undefined,
						attributes: { sizeMatched, realizedFillSource: "unavailable" },
					}),
				})),
			);
			await runReconcileOnce(h.deps);
			expect(h.updateStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					final_order_observation: expect.objectContaining({
						order_id: "venue-1",
						filled_size_usdc: 0,
						fill_evidence: "explicit_zero_size_matched",
					}),
				}),
			);
		},
	);
	it("records coherent canceled fill proof but does not fabricate it from a limit", async () => {
		const h = harness(
			[row({ order_id: "venue-1", status: "canceled" })],
			vi.fn(async () => ({ found: receipt({ status: "canceled" }) })),
		);
		await runReconcileOnce(h.deps);
		expect(h.updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				final_order_observation: expect.objectContaining({
					filled_size_usdc: 2,
					fill_evidence: "clob_associated_trades",
				}),
			}),
		);
	});
  it.each([
    ["live", "clob_associated_trades"],
    ["paper", undefined],
    ["paper", "paper_order_receipt"],
  ] as const)("keeps %s source=%s cost regression unresolved until coherent proof", async (mode, source) => {
    const prior = row({
      mode,
			order_id: "venue-1",
			status: "partial",
			executed_shares: 10,
			attributes: {
				size_usdc: 8,
				filled_size_usdc: 8,
        submitted_at: NOW.toISOString(),
        ...(source ? { realized_fill_source: source } : {}),
			},
		});
		const get = vi
			.fn()
			.mockResolvedValueOnce({
				found: receipt({
					status: "canceled",
					total_shares: 12,
					fill_price: 0.5,
					filled_size_usdc: 6,
          attributes: mode === "paper" ? { sizeMatched: 12 } : { realizedFillSource: "clob_associated_trades", sizeMatched: 12 },
				}),
			})
			.mockResolvedValueOnce({
				found: receipt({
					status: "canceled",
					total_shares: 12,
					fill_price: 0.75,
					filled_size_usdc: 9,
          attributes: mode === "paper" ? { sizeMatched: 12 } : { realizedFillSource: "clob_associated_trades", sizeMatched: 12 },
				}),
			});
		const h = harness([prior], get);
		await runReconcileOnce(h.deps);
		expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "verified_cumulative_cost_regression" }),
      expect.any(String),
    );
		expect(h.markSynced).toHaveBeenCalledWith(["coid-1"]);
		expect(h.markReconcileAttempted).toHaveBeenCalledWith(["coid-1"]);
		await runReconcileOnce(h.deps);
		expect(h.updateStatus).toHaveBeenCalledOnce();
		expect(h.updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				total_shares: 12,
				fill_price: 0.75,
				filled_size_usdc: 9,
        realized_fill_source: mode === "paper" ? "paper_order_receipt" : "clob_associated_trades",
				final_order_observation: expect.objectContaining({
					filled_size_usdc: 9,
				}),
			}),
		);
		expect(h.place).not.toHaveBeenCalled();
	});

  it.each([
    ["live", "estimated"],
    ["paper", "estimated"],
    ["paper", "data_api_activity_position"],
  ] as const)("allows authoritative %s receipts to replace %s", async (mode, source) => {
		const h = harness(
			[
				row({
          mode,
					order_id: "venue-1",
					status: "partial",
					executed_shares: 10,
					attributes: {
						size_usdc: 8,
						filled_size_usdc: 8,
						realized_fill_source: source,
            submitted_at: NOW.toISOString(),
					},
				}),
			],
			vi.fn(async () => ({
				found: receipt({
					status: "canceled",
					total_shares: 12,
					fill_price: 0.5,
					filled_size_usdc: 6,
          attributes: mode === "paper" ? { sizeMatched: 12 } : { realizedFillSource: "clob_associated_trades", sizeMatched: 12 },
				}),
			})),
		);
		await runReconcileOnce(h.deps);
		expect(h.updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				total_shares: 12,
				fill_price: 0.5,
				filled_size_usdc: 6,
        realized_fill_source: mode === "paper" ? "paper_order_receipt" : "clob_associated_trades",
				final_order_observation: expect.objectContaining({
					filled_size_usdc: 6,
				}),
			}),
		);
		expect(h.place).not.toHaveBeenCalled();
	});

	it("rotates thrown reads and continues independent rows, without fabricating freshness", async () => {
		const get = vi
			.fn()
			.mockRejectedValueOnce(new Error("upstream timeout"))
			.mockResolvedValueOnce({ found: receipt({ order_id: "venue-2" }) });
		const h = harness(
			[
				row({ order_id: "venue-1" }),
				row({
					client_order_id: "coid-2",
					order_id: "venue-2",
      status: "error",
				}),
			],
			get,
		);
		await runReconcileOnce(h.deps);
		expect(h.markReconcileAttempted).toHaveBeenCalledWith(["coid-1", "coid-2"]);
		expect(h.markSynced).toHaveBeenCalledWith(["coid-2"]);
		expect(h.updateStatus).toHaveBeenCalledTimes(1);
		expect(h.place).not.toHaveBeenCalled();
	});
	it("rejects an authenticated response for a different order identity", async () => {
		const h = harness(
			[row({ order_id: "venue-other" })],
			vi.fn(async () => ({ found: receipt() })),
		);
		await runReconcileOnce(h.deps);
		expect(h.updateStatus).not.toHaveBeenCalled();
		expect(h.markReconcileAttempted).toHaveBeenCalled();
    });
  });
