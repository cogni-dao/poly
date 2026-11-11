// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * bug.5060 — live mirror orders FILL on Polymarket but the ledger never
 * recorded it and the resting sweep then marked the filled order canceled.
 *   (a) reconciler: pending live order that the CLOB reports filled → persisted
 *       as filled with filled_size_usdc.
 *   (b) sweep: order with fills is recorded, not canceled / marked canceled.
 *   (c) ledger: a canceled row upgrades to filled/partial on fill evidence.
 */

import type { LoggerPort, OrderReceipt } from "@cogni/poly-market-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type OrderReconcilerDeps,
	runReconcileOnce,
} from "@/bootstrap/jobs/order-reconciler.job";
import { startRestingSweep } from "@/bootstrap/jobs/poly-mirror-resting-sweep.job";
import { monotonicLedgerStatus } from "@/features/trading/order-ledger";
import type { LedgerRow } from "@/features/trading/order-ledger.types";

const NOW = new Date("2026-11-11T10:46:00Z");
const ORDER_ID = "0x86841d46e03c";

function logger(): LoggerPort {
	const l = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: () => l,
	};
	return l as unknown as LoggerPort;
}

function filledReceipt(): OrderReceipt {
	return {
		order_id: ORDER_ID,
		client_order_id: ORDER_ID,
		status: "filled",
		filled_size_usdc: 1.034,
		fill_price: 0.1,
		total_shares: 10.34,
		submitted_at: NOW.toISOString(),
		attributes: { realizedFillSource: "clob_associated_trades" },
	} as OrderReceipt;
}

describe("bug.5060 (a) reconciler persists a live fill", () => {
	it("pending live order reported filled by the CLOB → updateStatus filled + filled_size_usdc", async () => {
		const row = {
			target_id: "t",
			fill_id: "f",
			observed_at: NOW,
			client_order_id: "coid-1",
			billing_account_id: "acct-1",
			order_id: ORDER_ID,
			status: "pending",
			position_lifecycle: null,
			mode: "live",
			created_at: new Date("2026-11-11T10:44:22Z"),
			updated_at: new Date("2026-11-11T10:44:22Z"),
			synced_at: null,
			attributes: { size_usdc: 1.24 },
		} as unknown as LedgerRow;
		const updateStatus = vi.fn(async () => {});
		const deps = {
			ledger: {
				listOpenOrPending: async () => [row],
				updateStatus,
				markSynced: vi.fn(async () => {}),
				markReconcileAttempted: vi.fn(async () => {}),
			},
			getOrderForTenant: vi.fn(async () => ({ found: filledReceipt() })),
			logger: logger(),
			metrics: { incr: vi.fn(), observeDurationMs: vi.fn() },
			notFoundGraceMs: 1,
			clock: () => NOW,
		} as unknown as OrderReconcilerDeps;

		await runReconcileOnce(deps);

		expect(updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				client_order_id: "coid-1",
				order_id: ORDER_ID,
				status: "filled",
				filled_size_usdc: 1.034,
				total_shares: 10.34,
				realized_fill_source: "clob_associated_trades",
			}),
		);
	});
});

describe("bug.5060 (b) resting sweep reads fill state before canceling", () => {
	const stops: Array<() => void> = [];
	afterEach(() => {
		for (const s of stops.splice(0)) s();
	});

	function sweepHarness(read: () => Promise<unknown>) {
		const markCanceled = vi.fn(async () => {});
		const updateStatus = vi.fn(async () => {});
		const cancel = vi.fn(async () => {});
		const deps = {
			ledger: {
				findStaleOpen: async () => [
					{
						client_order_id: "coid-1",
						order_id: ORDER_ID,
						status: "pending",
						billing_account_id: "acct-1",
						target_id: "t",
						market_id: "m",
						created_at: new Date("2026-11-11T10:44:22Z"),
						mode: "live",
						limit_price: 0.12,
					},
				],
				markCanceled,
				updateStatus,
			},
			cancelOrderFor: async () => cancel,
			getOrderFor: async () => read,
			logger: logger(),
			metrics: { incr: vi.fn(), observeDurationMs: vi.fn() },
			intervalMs: 60_000,
		} as unknown as Parameters<typeof startRestingSweep>[0];
		return { deps, markCanceled, updateStatus, cancel };
	}

	it("filled order: records the fill, never cancels or marks canceled", async () => {
		const h = sweepHarness(async () => ({ found: filledReceipt() }));
		stops.push(startRestingSweep(h.deps));
		await vi.waitFor(() => expect(h.updateStatus).toHaveBeenCalled());
		expect(h.updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				client_order_id: "coid-1",
				status: "filled",
				filled_size_usdc: 1.034,
				realized_fill_source: "clob_associated_trades",
			}),
		);
		expect(h.cancel).not.toHaveBeenCalled();
		expect(h.markCanceled).not.toHaveBeenCalled();
	});

	it("unfilled resting order: still canceled and marked ttl_expired", async () => {
		const h = sweepHarness(async () => ({
			found: { ...filledReceipt(), status: "open", filled_size_usdc: 0 },
		}));
		stops.push(startRestingSweep(h.deps));
		await vi.waitFor(() => expect(h.markCanceled).toHaveBeenCalled());
		expect(h.cancel).toHaveBeenCalledWith(ORDER_ID);
		expect(h.updateStatus).not.toHaveBeenCalled();
	});

	it("partial fill: records the fill, cancels only the remainder", async () => {
		const h = sweepHarness(async () => ({
			found: { ...filledReceipt(), status: "partial" },
		}));
		stops.push(startRestingSweep(h.deps));
		await vi.waitFor(() => expect(h.markCanceled).toHaveBeenCalled());
		expect(h.updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: "partial" }),
		);
		expect(h.cancel).toHaveBeenCalledWith(ORDER_ID);
	});

	it("read failure: falls back to cancel-and-mark (reconciler recovers later)", async () => {
		const h = sweepHarness(async () => {
			throw new Error("clob unavailable");
		});
		stops.push(startRestingSweep(h.deps));
		await vi.waitFor(() => expect(h.markCanceled).toHaveBeenCalled());
		expect(h.cancel).toHaveBeenCalledWith(ORDER_ID);
	});
});

describe("bug.5060 (c) ledger status monotonicity", () => {
	it("canceled upgrades to filled/partial on authenticated fill evidence", () => {
		expect(monotonicLedgerStatus("canceled", "filled")).toBe("filled");
		expect(monotonicLedgerStatus("canceled", "partial")).toBe("partial");
	});
	it("canceled is not resurrected by open/pending; filled is terminal", () => {
		expect(monotonicLedgerStatus("canceled", "open")).toBe("canceled");
		expect(monotonicLedgerStatus("canceled", "pending")).toBe("canceled");
		expect(monotonicLedgerStatus("filled", "canceled")).toBe("filled");
		expect(monotonicLedgerStatus("pending", "filled")).toBe("filled");
	});
});
