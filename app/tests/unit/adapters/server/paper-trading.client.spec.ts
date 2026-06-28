// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

import {
  createPaperTradingClientFromEnv,
  PaperTradingClient,
  PaperTradingSidecarError,
} from "@/adapters/server/paper-trading";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PaperTradingClient", () => {
  it("uses the configured sidecar URL for health, version, and order lifecycle", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "http://127.0.0.1:9100/healthz") {
        return jsonResponse({ status: "ok" });
      }
      if (url === "http://127.0.0.1:9100/version") {
        return jsonResponse({
          buildSha: "abc123",
          upstreamPaperTraderSha: "upstream123",
        });
      }
      if (url === "http://127.0.0.1:9100/place-order") {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(init?.body as string)).toMatchObject({
          client_order_id: "co-1",
          market_id: "prediction-market:polymarket:0xabc",
          side: "BUY",
        });
        return jsonResponse({
          order_id: "boot-1",
          client_order_id: "co-1",
          status: "open",
          filled_size_usdc: 0,
          submitted_at: "2026-06-28T22:00:00Z",
        });
      }
      if (url === "http://127.0.0.1:9100/orders/boot-1") {
        return jsonResponse({
          order_id: "boot-1",
          client_order_id: "co-1",
          status: "open",
          filled_size_usdc: 0,
          submitted_at: "2026-06-28T22:00:00Z",
        });
      }
      if (url === "http://127.0.0.1:9100/orders/boot-1/cancel") {
        expect(init?.method).toBe("POST");
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected URL ${url}`);
    });

    const client = new PaperTradingClient({ fetchImpl });
    await expect(client.health()).resolves.toEqual({ status: "ok" });
    await expect(client.version()).resolves.toEqual({
      buildSha: "abc123",
      upstreamPaperTraderSha: "upstream123",
    });
    const order = await client.placeOrder({
      client_order_id: "co-1",
      market_id: "prediction-market:polymarket:0xabc",
      outcome: "YES",
      side: "BUY",
      size_usdc: 10,
      limit_price: 0.5,
    });
    expect(order.order_id).toBe("boot-1");
    await expect(client.getOrder("boot-1")).resolves.toMatchObject({
      order_id: "boot-1",
    });
    await expect(client.cancelOrder("boot-1")).resolves.toBeUndefined();
  });

  it("returns null for missing getOrder but throws structured errors otherwise", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/orders/missing")) {
        return new Response(null, { status: 404 });
      }
      return new Response("boom", { status: 500 });
    });
    const client = new PaperTradingClient({ fetchImpl });

    await expect(client.getOrder("missing")).resolves.toBeNull();
    await expect(client.cancelOrder("broken")).rejects.toBeInstanceOf(
      PaperTradingSidecarError
    );
  });

  it("refuses env construction when mode is not paper", () => {
    expect(() =>
      createPaperTradingClientFromEnv({
        PAPER_ENFORCE_MODE: "disabled",
        PAPER_SIDECAR_URL: "http://127.0.0.1:9100",
      })
    ).toThrow(/PAPER_ENFORCE_MODE=paper/);
  });
});
