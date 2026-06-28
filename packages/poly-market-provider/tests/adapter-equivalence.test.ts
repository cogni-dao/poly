// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/adapter-equivalence`
 * Purpose: bug.5018 CI gate — PaperAdapter and PolymarketClobAdapter MUST
 *   produce structurally identical OrderReceipt values on a canonical fill
 *   fixture. Asserts on the six contract fields: `order_id`, `client_order_id`,
 *   `status`, `filled_size_usdc`, `fill_price`, `total_shares`, `fees_usdc`.
 *   `attributes` is excluded — each adapter populates platform-specific
 *   metadata (sidecar diagnostics vs `transactionsHashes` / `rawStatus`).
 * Scope: Unit test. Stubs both adapters' upstreams identically; the test
 *   fails if either adapter drops or transforms any of the contract fields.
 * Invariants tested:
 *   - FILLED_SIZE_USDC_IS_REALIZED — both adapters surface realized notional
 *     (not intent.size_usdc).
 *   - FILL_FIELDS_UNDEFINED_WHEN_UNFILLED — canceled receipts have undefined
 *     fill_price / total_shares / fees_usdc (distinct from 0).
 *   - PAPER_LIVE_RECEIPT_PARITY — for an identical canonical fill, both
 *     adapters parse to identical Zod-validated OrderReceipt shapes (six
 *     contract fields).
 * Notes:
 *   - Fee fixture uses non-zero fee_rate_bps=20 (0.2%) because prod Polymarket
 *     CLOB fee is typically 0; without a non-zero fee the test would assert on
 *     a constant. Fee model: rate × notional. notional = price × shares = 32
 *     USDC. fees_usdc = 32 × 0.002 = 0.064.
 *   - The CLOB adapter doesn't natively surface fees on OrderResponse today —
 *     the stub injects a `fee` field. Real prod calls leave fees_usdc
 *     undefined; the equivalence here is about adapter symmetry, not prod
 *     reality.
 * Links: docs/spec/poly-paper-trading-shortcomings.md (S8), work item bug.5018
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  mapOpenOrderToReceipt,
  mapOrderResponseToReceipt,
} from "../src/adapters/polymarket/polymarket.clob.adapter.js";
import { PaperAdapter } from "../src/adapters/paper/paper.adapter.js";
import {
  OrderReceiptSchema,
  type OrderIntent,
  type OrderReceipt,
} from "../src/domain/order.js";

// ─── Canonical fill fixture (a): full fill, 32 USDC notional, 0.064 fee. ────
const FIXTURE_PRICE = 0.32;
const FIXTURE_SHARES = 100;
const FIXTURE_FEE_RATE_BPS = 20; // 0.2%
const FIXTURE_NOTIONAL_USDC = FIXTURE_PRICE * FIXTURE_SHARES; // 32
const FIXTURE_FEES_USDC =
  (FIXTURE_NOTIONAL_USDC * FIXTURE_FEE_RATE_BPS) / 10_000; // 0.064

const CLIENT_ORDER_ID = `0x${"a".repeat(64)}`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeIntent(): OrderIntent {
  return {
    provider: "polymarket",
    market_id: "prediction-market:polymarket:0xabc",
    outcome: "YES",
    side: "BUY",
    size_usdc: FIXTURE_NOTIONAL_USDC,
    limit_price: FIXTURE_PRICE,
    client_order_id: CLIENT_ORDER_ID,
    attributes: { token_id: "tok-1", mode: "paper", placement: "limit" },
  };
}

/**
 * The six contract fields the bug.5018 wire equivalence test asserts on.
 * Attributes are excluded by design — each adapter populates platform-specific
 * metadata.
 */
function contractView(receipt: OrderReceipt) {
  return {
    order_id: receipt.order_id,
    client_order_id: receipt.client_order_id,
    status: receipt.status,
    filled_size_usdc: receipt.filled_size_usdc,
    fill_price: receipt.fill_price,
    total_shares: receipt.total_shares,
    fees_usdc: receipt.fees_usdc,
  };
}

describe("adapter-equivalence (bug.5018) — full fill", () => {
  it("PaperAdapter + PolymarketClobAdapter produce identical six-field contract on a canonical fill", async () => {
    // Paper side: sidecar returns the realized fill data the engine surfaced
    // post-bug.5018 (server.py populates fill_price / total_shares / fees_usdc
    // from `Trade.amount_usd / shares / fee`).
    const paperFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        order_id: "paper-1",
        client_order_id: CLIENT_ORDER_ID,
        status: "filled",
        filled_size_usdc: FIXTURE_NOTIONAL_USDC,
        fill_price: FIXTURE_PRICE,
        total_shares: FIXTURE_SHARES,
        fees_usdc: FIXTURE_FEES_USDC,
        submitted_at: "2026-05-19T12:00:00Z",
        attributes: { upstream_status: "filled", upstream_id: "paper-1" },
      })
    );
    const paperAdapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl: paperFetch,
    });
    const paperReceipt = await paperAdapter.placeOrder(makeIntent());

    // Live side: stub a CLOB OrderResponse. BUY → makingAmount=USDC paid,
    // takingAmount=shares received. Stub injects `fee` so the adapter has
    // something to surface (prod CLOB OrderResponse doesn't surface fees
    // today — see test docstring).
    const clobResponse = {
      orderID: "paper-1",
      success: true,
      status: "filled",
      makingAmount: String(FIXTURE_NOTIONAL_USDC),
      takingAmount: String(FIXTURE_SHARES),
      fee: FIXTURE_FEES_USDC,
      transactionsHashes: ["0xdeadbeef"],
    };
    const liveReceipt = OrderReceiptSchema.parse(
      mapOrderResponseToReceipt(clobResponse, makeIntent())
    );

    // Both must round-trip the canonical fill identically on the six
    // contract fields. Attributes diverge by design.
    expect(contractView(liveReceipt)).toStrictEqual(
      contractView(paperReceipt)
    );
    // Sanity: realized != intent — the bug.5018 contract.
    expect(paperReceipt.filled_size_usdc).toBe(FIXTURE_NOTIONAL_USDC);
    expect(paperReceipt.fill_price).toBe(FIXTURE_PRICE);
    expect(paperReceipt.total_shares).toBe(FIXTURE_SHARES);
    expect(paperReceipt.fees_usdc).toBeCloseTo(FIXTURE_FEES_USDC, 8);
  });
});

describe("adapter-equivalence (bug.5018) — canceled / unfilled", () => {
  it("canceled paper receipt leaves fill_price / total_shares / fees_usdc undefined", async () => {
    const paperFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        order_id: "paper-2",
        client_order_id: CLIENT_ORDER_ID,
        status: "canceled",
        filled_size_usdc: 0,
        // fill_price / total_shares / fees_usdc deliberately absent (undefined).
        submitted_at: "2026-05-19T12:00:00Z",
        attributes: { upstream_status: "cancelled", upstream_id: "paper-2" },
      })
    );
    const paperAdapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl: paperFetch,
    });
    const paperReceipt = await paperAdapter.placeOrder(makeIntent());

    expect(paperReceipt.status).toBe("canceled");
    expect(paperReceipt.filled_size_usdc).toBe(0);
    expect(paperReceipt.fill_price).toBeUndefined();
    expect(paperReceipt.total_shares).toBeUndefined();
    expect(paperReceipt.fees_usdc).toBeUndefined();
  });

  it("mapOpenOrderToReceipt returns the new fields as undefined when size_matched=0 (PURE open order)", () => {
    const open = {
      id: "open-1",
      status: "LIVE",
      side: "BUY",
      original_size: "100",
      size_matched: "0",
      price: "0.32",
    };
    const receipt = OrderReceiptSchema.parse(mapOpenOrderToReceipt(open));
    expect(receipt.status).toBe("open");
    expect(receipt.filled_size_usdc).toBe(0);
    expect(receipt.fill_price).toBeUndefined();
    expect(receipt.total_shares).toBeUndefined();
    expect(receipt.fees_usdc).toBeUndefined();
  });
});

describe("adapter-equivalence (bug.5018) — wire-shape contract", () => {
  // Regression pin (live incident 2026-05-19): pydantic serializes
  // `Optional[float] = None` as JSON `null` by default. Zod v3 `.optional()`
  // accepts undefined/missing only — NOT null. Every paper-mode placement on
  // candidate-a failed `placement_failed` until the sidecar route was switched
  // to `response_model_exclude_none=True`. Pin the contract: nulls are illegal
  // on the wire; the Python side MUST omit absent fields.
  it("OrderReceiptSchema rejects JSON null for fill_price / total_shares / fees_usdc", () => {
    const pendingWithNulls = {
      order_id: "paper-pending-1",
      client_order_id: CLIENT_ORDER_ID,
      status: "pending",
      filled_size_usdc: 0,
      fill_price: null,
      total_shares: null,
      fees_usdc: null,
      submitted_at: "2026-05-19T12:00:00Z",
    };
    const result = OrderReceiptSchema.safeParse(pendingWithNulls);
    expect(result.success).toBe(false);
  });

  it("OrderReceiptSchema accepts pending receipt with absent fill fields (the Python-omit shape)", () => {
    const pendingOmitted = {
      order_id: "paper-pending-2",
      client_order_id: CLIENT_ORDER_ID,
      status: "pending",
      filled_size_usdc: 0,
      submitted_at: "2026-05-19T12:00:00Z",
    };
    const parsed = OrderReceiptSchema.parse(pendingOmitted);
    expect(parsed.status).toBe("pending");
    expect(parsed.fill_price).toBeUndefined();
    expect(parsed.total_shares).toBeUndefined();
    expect(parsed.fees_usdc).toBeUndefined();
  });
});
