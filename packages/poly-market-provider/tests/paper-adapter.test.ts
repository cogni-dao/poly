// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/paper-adapter`
 * Purpose: Unit tests for `PaperAdapter`'s sidecar IPC + readSource delegation.
 *   Stubs `fetch` so no network is touched — tests verify the wire shape sent
 *   to the sidecar, Zod parsing of responses, 404 → not_found discrimination
 *   on getOrder, and idempotent cancel (404 swallowed).
 * Scope: Unit tests only. Sidecar end-to-end + executor-dispatcher integration
 *   land in the app's test suite under `nodes/poly/app/tests/`.
 * Invariants tested:
 *   - PAPER_DELEGATES_READS_TO_LIVE — getMarketConstraints + listMarkets route to readSource.
 *   - PAPER_POPULATES_FILLED_USDC — receipt round-trips filled_size_usdc faithfully.
 *   - PAPER_GETORDER_NEVER_NULL — 404 → { status: "not_found" }, never null.
 *   - PACKAGES_NO_ENV — adapter takes no env; fetch impl is constructor-injected.
 * Links: nodes/poly/packages/market-provider/src/adapters/paper/paper.adapter.ts,
 *   work/projects/proj.poly-paper-trading.md
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  PaperAdapter,
  PaperAdapterError,
} from "../src/adapters/paper/paper.adapter.js";
import type { OrderIntent } from "../src/domain/order.js";
import type { MarketProviderPort } from "../src/port/market-provider.port.js";

function makeIntent(overrides?: Partial<OrderIntent>): OrderIntent {
  return {
    provider: "polymarket",
    market_id: "prediction-market:polymarket:0xabc",
    outcome: "YES",
    side: "BUY",
    size_usdc: 5,
    limit_price: 0.42,
    client_order_id:
      "0x" + "a".repeat(64),
    attributes: { token_id: "tok-1", mode: "paper", placement: "limit" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PaperAdapter — sidecar IPC", () => {
  it("placeOrder posts to /place-order and parses the OrderReceipt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        order_id: "paper-1",
        client_order_id: "0x" + "a".repeat(64),
        status: "filled",
        filled_size_usdc: 5,
        submitted_at: "2026-05-14T12:00:00Z",
        attributes: { simulated: true },
      })
    );
    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl,
    });
    const receipt = await adapter.placeOrder(makeIntent());

    expect(receipt.order_id).toBe("paper-1");
    expect(receipt.status).toBe("filled");
    expect(receipt.filled_size_usdc).toBe(5);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://sidecar:9100/place-order");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_order_id: "0x" + "a".repeat(64),
      market_id: "prediction-market:polymarket:0xabc",
      token_id: "tok-1",
      side: "BUY",
      size_usdc: 5,
      limit_price: 0.42,
    });
  });

  it("placeOrder rejects when sidecar returns non-2xx — with structured details (bug.5060)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl,
    });
    try {
      await adapter.placeOrder(makeIntent());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaperAdapterError);
      const e = err as PaperAdapterError;
      expect(e.message).toMatch(/place-order failed: 500/);
      expect(e.details).toEqual({
        error_code: "paper_sidecar_http_error",
        reason: "boom",
        error_class: "PaperAdapterError",
        operation: "placeOrder",
        http_status: 500,
        response_body: "boom",
      });
    }
  });

  it("placeOrder throws paper_intent_invalid with Zod reason when intent fails the request schema (bug.5060)", async () => {
    const fetchImpl = vi.fn();
    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl,
    });
    // size_usdc=0 violates `z.number().positive()` — must throw BEFORE
    // hitting the network and surface a typed reason.
    try {
      await adapter.placeOrder(makeIntent({ size_usdc: 0 }));
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaperAdapterError);
      const e = err as PaperAdapterError;
      expect(e.details.error_code).toBe("paper_intent_invalid");
      expect(e.details.operation).toBe("placeOrder");
      expect(e.details.reason).toMatch(/size_usdc/);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("placeOrder throws paper_sidecar_unavailable when fetch rejects (network error, bug.5060)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl,
    });
    try {
      await adapter.placeOrder(makeIntent());
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaperAdapterError);
      const e = err as PaperAdapterError;
      expect(e.details.error_code).toBe("paper_sidecar_unavailable");
      expect(e.details.reason).toBe("ECONNREFUSED");
    }
  });

  it("getOrder returns { found } on 200 and { status: 'not_found' } on 404", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      if ((url as string).endsWith("/orders/missing")) {
        return new Response(null, { status: 404 });
      }
      return jsonResponse({
        order_id: "paper-1",
        client_order_id: "0x" + "a".repeat(64),
        status: "open",
        filled_size_usdc: 0,
        submitted_at: "2026-05-14T12:00:00Z",
      });
    });
    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl,
    });

    const found = await adapter.getOrder("paper-1");
    expect("found" in found && found.found.order_id).toBe("paper-1");

    const missing = await adapter.getOrder("missing");
    expect(missing).toEqual({ status: "not_found" });
  });

  it("cancelOrder swallows 404s but throws on other non-2xx", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url) => {
      const u = url as string;
      if (u.includes("/orders/missing/cancel"))
        return new Response(null, { status: 404 });
      if (u.includes("/orders/broken/cancel"))
        return new Response("nope", { status: 500 });
      return new Response(null, { status: 204 });
    });
    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      fetchImpl,
    });

    await expect(adapter.cancelOrder("paper-1")).resolves.toBeUndefined();
    await expect(adapter.cancelOrder("missing")).resolves.toBeUndefined();
    await expect(adapter.cancelOrder("broken")).rejects.toThrow(
      /cancel-order failed: 500/
    );
  });
});

describe("PaperAdapter — readSource delegation", () => {
  it("getMarketConstraints delegates to readSource verbatim", async () => {
    const fetchImpl = vi.fn();
    const readSource = {
      provider: "polymarket" as const,
      listMarkets: vi.fn(),
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getOrder: vi.fn(),
      getMarketConstraints: vi
        .fn()
        .mockResolvedValue({ minShares: 5, tickSize: 0.01, minUsdcNotional: 1 }),
    } satisfies MarketProviderPort;

    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      readSource,
      fetchImpl,
    });

    const constraints = await adapter.getMarketConstraints("tok-1");
    expect(constraints).toEqual({
      minShares: 5,
      tickSize: 0.01,
      minUsdcNotional: 1,
    });
    expect(readSource.getMarketConstraints).toHaveBeenCalledWith("tok-1");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("listMarkets delegates to readSource verbatim", async () => {
    const fetchImpl = vi.fn();
    const readSource = {
      provider: "polymarket" as const,
      listMarkets: vi.fn().mockResolvedValue([]),
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      getOrder: vi.fn(),
      getMarketConstraints: vi.fn(),
    } satisfies MarketProviderPort;

    const adapter = new PaperAdapter({
      sidecarBaseUrl: "http://sidecar:9100",
      readSource,
      fetchImpl,
    });

    const markets = await adapter.listMarkets({ status: "open" });
    expect(markets).toEqual([]);
    expect(readSource.listMarkets).toHaveBeenCalledWith({ status: "open" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
