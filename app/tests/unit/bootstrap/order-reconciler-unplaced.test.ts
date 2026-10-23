// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Recovery reads may repair accepted orders, never infer nonexecution or PLACE. */
import { describe, expect, it, vi } from "vitest";
import type { OrderReconcilerDeps } from "@/bootstrap/jobs/order-reconciler.job";
import { ORDER_RECONCILER_METRICS, runReconcileOnce } from "@/bootstrap/jobs/order-reconciler.job";
import type {
	AcceptedOrderObservation,
	LedgerRow,
	OrderObservationWriteResult,
} from "@/features/trading/order-ledger.types";
import { EVENT_NAMES } from "@/shared/observability/events";

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
	const updateStatus = vi.fn(async (): Promise<OrderObservationWriteResult> => {});
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
		leaf,
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
		const before = structuredClone(prior);
		const h = harness([prior], get);
		await runReconcileOnce(h.deps);
		expect(h.updateStatus).not.toHaveBeenCalled();
    expect(prior).toEqual(before);
    expect(h.deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "verified_cumulative_cost_regression", reconcile_stage: "validate_cumulative_cost" }),
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


describe("durable observation success reporting", () => {
	it.each([
		{ accepted: false, retainedProof: false },
		{ accepted: false, retainedProof: true },
		{ accepted: true, retainedProof: true },
	])(
		"reports durable status with accepted=$accepted and retainedProof=$retainedProof",
		async ({ accepted, retainedProof }) => {
			const prior = row({
				order_id: "venue-1",
				mode: "paper",
				status: !accepted && retainedProof ? "partial" : "open",
			});
			const h = harness(
				[prior],
				vi.fn(async () => ({ found: receipt() })),
			);
			const observation: AcceptedOrderObservation = {
				mode: "paper",
				client_order_id: "coid-1",
				order_id: "venue-1",
				status: accepted ? "partial" : prior.status,
				accepted,
				accounting: retainedProof
					? {
							status: "verified_positive",
							facts: {
								version: 1,
								mode: "paper",
								source: "paper_order_receipt",
								billing_account_id: "acct-1",
								connection_id: "connection-1",
								client_order_id: "coid-1",
								order_id: "venue-1",
								condition_id: `0x${"a".repeat(64)}`,
								token_id: "123",
								side: "BUY",
								shares: 2,
								notional_usdc: 1,
								price: 0.5,
								fee_known: true,
								fees_usdc: 0,
								venue_status: "partial",
								terminal: false,
								observed_at: NOW.toISOString(),
								proof_key: "prior-proof",
							},
						}
					: {
							status: "mismatch",
							reason: "paper_cumulative_observation_contradiction",
						},
			};
			h.updateStatus.mockResolvedValueOnce(observation);
			const callback = vi.fn();
			h.deps.onOrderChanged = callback;

			await runReconcileOnce(h.deps);

			expect(h.updateStatus).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ status: "filled" }),
			);
			expect(callback).toHaveBeenCalledExactlyOnceWith(prior, {
				status: observation.status,
				acceptedObservation: observation,
			});
			if (accepted) {
				expect(h.deps.metrics.incr).toHaveBeenCalledWith(
					ORDER_RECONCILER_METRICS.updatesTotal,
					{ from: "open", to: "partial" },
				);
				expect(h.leaf.info).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({
						event: EVENT_NAMES.POLY_RECONCILER_STATUS_UPDATED,
						from: "open",
						to: "partial",
					}),
					"reconciler: authenticated order observation persisted",
				);
				expect(h.leaf.warn).not.toHaveBeenCalled();
			} else {
				expect(h.deps.metrics.incr).not.toHaveBeenCalledWith(
					ORDER_RECONCILER_METRICS.updatesTotal,
					expect.anything(),
				);
				expect(h.leaf.info).not.toHaveBeenCalled();
				expect(h.leaf.warn).toHaveBeenCalledExactlyOnceWith(
					{
						event: EVENT_NAMES.POLY_MIRROR_RECONCILE_TICK_ERROR,
						errorCode: "order_observation_rejected",
					},
					"reconciler: authenticated order observation rejected",
				);
				expect(callback.mock.invocationCallOrder[0]).toBeLessThan(
					h.leaf.warn.mock.invocationCallOrder[0],
				);
			}
			expect(h.deps.metrics.incr).not.toHaveBeenCalledWith(
				ORDER_RECONCILER_METRICS.updatesTotal,
				{ from: prior.status, to: "filled" },
			);
			expect(h.leaf.error).not.toHaveBeenCalled();
			expect(h.markSynced).toHaveBeenCalledExactlyOnceWith(["coid-1"]);
			expect(h.markReconcileAttempted).toHaveBeenCalledExactlyOnceWith([
				"coid-1",
			]);
			expect(h.deps.metrics.incr).toHaveBeenCalledWith(
				ORDER_RECONCILER_METRICS.ticksTotal,
				{},
			);
			expect(h.place).not.toHaveBeenCalled();
		},
	);

	it("preserves live success reporting for a void writer acknowledgment", async () => {
		const prior = row({ order_id: "venue-1", status: "open" });
		const h = harness(
			[prior],
			vi.fn(async () => ({ found: receipt() })),
		);
		const callback = vi.fn();
		h.deps.onOrderChanged = callback;

		await runReconcileOnce(h.deps);

		expect(callback).toHaveBeenCalledExactlyOnceWith(prior, {
			status: "filled",
		});
		expect(h.deps.metrics.incr).toHaveBeenCalledWith(
			ORDER_RECONCILER_METRICS.updatesTotal,
			{ from: "open", to: "filled" },
		);
		expect(h.leaf.info).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				event: EVENT_NAMES.POLY_RECONCILER_STATUS_UPDATED,
				from: "open",
				to: "filled",
			}),
			"reconciler: authenticated order observation persisted",
		);
		expect(h.leaf.error).not.toHaveBeenCalled();
	});
});

describe("known-order failure boundary diagnostics", () => {
  const sentinel = "SQL_PARAMS_SECRET_SENTINEL";
  function databaseFailure(code: string) {
    return new Error(sentinel, {
      cause: Object.assign(new Error(sentinel), { name: "PostgresError", code }),
    });
  }

  it.each(["live", "paper", "unexpected"] as const)(
    "correlates nested read failures without changing %s dispatch or freshness",
    async (mode) => {
      const first = row({ order_id: "venue-1", mode: mode as LedgerRow["mode"] });
      const before = structuredClone(first);
      const h = harness([
        first,
        row({ client_order_id: "coid-2", order_id: "venue-2" }),
      ], vi.fn().mockRejectedValueOnce(databaseFailure("53300"))
        .mockResolvedValueOnce({ found: receipt({ order_id: "venue-2" }) }));
      await runReconcileOnce(h.deps);
      expect(h.getOrder).toHaveBeenNthCalledWith(1, "acct-1", "venue-1", mode);
      expect(h.leaf.error).toHaveBeenCalledWith({
        event: "poly.mirror.reconcile.tick_error",
        errorCode: "reconcile_row_error",
        client_order_id: "coid-1", order_id: "venue-1",
        billing_account_id: "acct-1", mode: mode === "unexpected" ? "unknown" : mode,
        reconcile_stage: "executor_order_read",
        err_class: "Error", err_code: undefined,
        cause_class: "PostgresError", cause_code: "53300",
      }, "reconciler: row processing failed");
      expect(JSON.stringify(h.leaf.error.mock.calls)).not.toContain(sentinel);
      expect(first).toEqual(before);
      expect(h.updateStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ client_order_id: "coid-2" }));
      expect(h.markReconcileAttempted).toHaveBeenCalledExactlyOnceWith(["coid-1", "coid-2"]);
      expect(h.markSynced).toHaveBeenCalledExactlyOnceWith(["coid-2"]);
      expect(h.place).not.toHaveBeenCalled();
    },
  );

  it.each([null, { found: receipt({ order_id: "wrong" }) }])(
    "classifies invalid response %s and continues later rows", async (invalid) => {
      const h = harness([
        row({ order_id: "venue-1" }),
        row({ client_order_id: "coid-2", order_id: "venue-2" }),
      ], vi.fn().mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce({ found: receipt({ order_id: "venue-2" }) }));
      await runReconcileOnce(h.deps);
      expect(h.leaf.error).toHaveBeenCalledWith(expect.objectContaining({
        reconcile_stage: "validate_order_response", errorCode: "reconcile_row_error",
      }), "reconciler: row processing failed");
      expect(h.updateStatus).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ client_order_id: "coid-2" }));
      expect(h.markSynced).toHaveBeenCalledExactlyOnceWith(["coid-2"]);
      expect(h.markReconcileAttempted).toHaveBeenCalledExactlyOnceWith(["coid-1", "coid-2"]);
      expect(h.place).not.toHaveBeenCalled();
    },
  );

  it.each([
    "prepare_status_update", "persist_status", "notify_order_changed",
    "record_update_metric", "log_status_updated",
  ] as const)("reports %s while preserving committed writes and continuation", async (stage) => {
    const first = row({ order_id: "venue-1", mode: "paper" });
    const before = structuredClone(first);
    const h = harness([first, row({ client_order_id: "coid-2", order_id: "venue-2" })],
      vi.fn().mockResolvedValueOnce({ found: receipt() })
        .mockResolvedValueOnce({ found: receipt({ order_id: "venue-2" }) }));
    const committed: string[] = [];
    h.updateStatus.mockImplementation(async (...args: unknown[]) => {
      committed.push((args[0] as { client_order_id: string }).client_order_id);
    });
    const callback = vi.fn();
    h.deps.onOrderChanged = callback;
    const fail = () => { throw databaseFailure("23514"); };
    if (stage === "prepare_status_update") h.deps.clock = vi.fn().mockImplementationOnce(fail).mockReturnValue(NOW);
    if (stage === "persist_status") h.updateStatus.mockRejectedValueOnce(databaseFailure("23514"));
    if (stage === "notify_order_changed") callback.mockImplementationOnce(fail);
    if (stage === "record_update_metric") vi.mocked(h.deps.metrics.incr).mockImplementationOnce(fail);
    if (stage === "log_status_updated") h.leaf.info.mockImplementationOnce(fail);
    await runReconcileOnce(h.deps);
    const postWrite = stage !== "prepare_status_update" && stage !== "persist_status";
    expect(committed).toEqual(postWrite ? ["coid-1", "coid-2"] : ["coid-2"]);
    expect(h.updateStatus).toHaveBeenCalledTimes(stage === "prepare_status_update" ? 1 : 2);
    expect(callback).toHaveBeenCalledTimes(postWrite ? 2 : 1);
    if (!postWrite) expect(callback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ client_order_id: "coid-2" }), { status: "filled" });
    expect(h.leaf.error).toHaveBeenCalledExactlyOnceWith({
      event: "poly.mirror.reconcile.tick_error", errorCode: "reconcile_row_error",
      client_order_id: "coid-1", order_id: "venue-1", billing_account_id: "acct-1", mode: "paper",
      reconcile_stage: stage, err_class: "Error", err_code: undefined,
      cause_class: "PostgresError", cause_code: "23514",
    }, "reconciler: row processing failed");
    expect(JSON.stringify(h.leaf.error.mock.calls)).not.toContain(sentinel);
    expect(first).toEqual(before);
    expect(h.markReconcileAttempted).toHaveBeenCalledExactlyOnceWith(["coid-1", "coid-2"]);
    expect(h.markSynced).toHaveBeenCalledExactlyOnceWith(["coid-1", "coid-2"]);
    expect(h.place).not.toHaveBeenCalled();
    expect(h.deps.metrics.incr).toHaveBeenCalledWith(ORDER_RECONCILER_METRICS.errorsTotal, {});
  });
});
