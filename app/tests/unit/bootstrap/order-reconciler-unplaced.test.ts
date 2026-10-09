// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/order-reconciler-unplaced`
 * Purpose: Pin UNPLACED_ROWS_TERMINALIZE — a ledger row that never received a
 *   CLOB order id must not stay `pending` forever.
 * Scope: Pure `runReconcileOnce` with fake ledger/getOrder/metrics. No DB, no
 *   network, no timers.
 * Invariants:
 *   - WITHIN_GRACE_IS_UNTOUCHED: placement may still be in flight.
 *   - PAST_GRACE_TERMINALIZES: promoted to `canceled` with reason
 *     `never_placed`, distinct from the not_found branch's `clob_not_found`.
 *   - PLACED_ROWS_UNAFFECTED: a row with an order id still goes to `getOrder`.
 * Side-effects: none
 * Links: src/bootstrap/jobs/order-reconciler.job.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import { runReconcileOnce } from "@/bootstrap/jobs/order-reconciler.job";

const NOT_FOUND_GRACE_MS = 900_000;
const UNPLACED_GRACE_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-07T00:00:00.000Z");

function row(overrides: Record<string, unknown>) {
  return {
    client_order_id: "coid-1",
    billing_account_id: "acct-1",
    order_id: null,
    status: "pending",
    // These cases pin the live venue's 24-hour crash-recovery grace. Paper
    // rows intentionally use a shorter grace and have their own reconciler
    // coverage.
    mode: "live",
    created_at: new Date(NOW.getTime() - UNPLACED_GRACE_MS * 2),
    attributes: {},
    ...overrides,
  };
}

function harness(rows: unknown[], getOrder = vi.fn()) {
  const updateStatus = vi.fn(async () => {});
  const markSynced = vi.fn(async () => {});
  const leaf = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    updateStatus,
    markSynced,
    getOrder,
    deps: {
      ledger: {
        listOpenOrPending: async () => rows,
        updateStatus,
        markSynced,
      },
      getOrderForTenant: getOrder,
      logger: { ...leaf, child: () => leaf },
      metrics: { incr: vi.fn(), observe: vi.fn() },
      notFoundGraceMs: NOT_FOUND_GRACE_MS,
      clock: () => NOW,
    },
  } as never as {
    updateStatus: ReturnType<typeof vi.fn>;
    markSynced: ReturnType<typeof vi.fn>;
    getOrder: ReturnType<typeof vi.fn>;
    // biome-ignore lint/suspicious/noExplicitAny: structural test double
    deps: any;
  };
}

describe("runReconcileOnce — rows that never got a CLOB order id", () => {
  it("leaves a fresh unplaced row alone (placement may be in flight)", async () => {
    const h = harness([
      row({ created_at: new Date(NOW.getTime() - UNPLACED_GRACE_MS / 2) }),
    ]);
    await runReconcileOnce(h.deps);
    expect(h.updateStatus).not.toHaveBeenCalled();
    expect(h.getOrder).not.toHaveBeenCalled();
  });

  it("does NOT terminalize on the short not_found grace alone", async () => {
    // The not_found window answers "CLOB slow to index an order we know
    // exists". This branch asserts no order exists, so it must not inherit
    // that window — a crash between venue-accept and markOrderId would be
    // misread as "never placed" within minutes.
    const h = harness([
      row({ created_at: new Date(NOW.getTime() - NOT_FOUND_GRACE_MS * 2) }),
    ]);
    await runReconcileOnce(h.deps);
    expect(h.updateStatus).not.toHaveBeenCalled();
  });

  it("terminalizes an unplaced row past the 24h grace window", async () => {
    // Before this fix the row was `continue`d unconditionally, so a months-old
    // pending row survived every tick and permanently blocked wallet reset.
    const h = harness([row({})]);
    await runReconcileOnce(h.deps);
    expect(h.updateStatus).toHaveBeenCalledWith({
      client_order_id: "coid-1",
      // `error`, not `canceled` — we never saw a venue response, so asserting
      // cancellation would claim state we cannot verify.
      status: "error",
      reason: "never_placed",
    });
  });

  it("does not stamp synced_at — no CLOB response was ever received", async () => {
    // `synced_at` means "a typed getOrder answer landed for this row". An
    // unplaced row never produced one, so claiming otherwise would make the
    // column lie. It drops out of listOpenOrPending once canceled anyway.
    const h = harness([row({})]);
    await runReconcileOnce(h.deps);
    expect(h.markSynced).toHaveBeenCalledWith([]);
  });

  it("still routes a row that HAS an order id through getOrder", async () => {
    const getOrder = vi.fn(async () => ({ found: { status: "CANCELED" } }));
    const h = harness([row({ order_id: "0xabc", status: "open" })], getOrder);
    await runReconcileOnce(h.deps);
    expect(getOrder).toHaveBeenCalledWith("acct-1", "0xabc", "live");
    expect(h.updateStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "never_placed" })
    );
  });
});
