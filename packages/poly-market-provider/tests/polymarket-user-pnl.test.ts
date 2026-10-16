// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/polymarket-user-pnl`
 * Purpose: Cover the public v2 P/L contract and its legacy chart normalization.
 * Scope: Injected fetch mocks and saved live fixtures; no live network I/O.
 * Invariants:
 *   - EMPTY_IS_HONEST: an upstream empty history stays empty; null is not zero.
 *   - COMPATIBLE_METRIC: native trade_pnl is the legacy chart's p.
 *   - IDENTITY_REQUIRED: wallet, window and output grid match the request.
 * Side-effects: none
 * Links: https://data-api.polymarket.com/v2/docs
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  PolymarketUserPnlClient,
  PolymarketUserPnlPointSchema,
} from "../src/adapters/polymarket/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type PnlFixture = {
  data: {
    proxy_wallet: string;
    interval: "1w" | "all";
    fidelity: "1h" | "1d";
    source_fidelity: string;
    points: { timestamp: number; trade_pnl: number; economic_pnl: number }[];
  };
};

function fixture(name: string): PnlFixture {
  return JSON.parse(
    readFileSync(path.resolve(__dirname, "fixtures", name), "utf8")
  ) as PnlFixture;
}

// Captured from the public v2 endpoint on 2026-10-16; retain representative
// first/last points and all native fields, including unavailable cashflows.
const WEEK_FIXTURE = fixture("polymarket-user-pnl-v2-week.json");
const ALL_FIXTURE = fixture("polymarket-user-pnl-v2-all.json");
const wallet = WEEK_FIXTURE.data.proxy_wallet;
const weeklyParams = { interval: "1w", fidelity: "1h" } as const;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

describe("PolymarketUserPnlClient.getUserPnl", () => {
  it.each([WEEK_FIXTURE, ALL_FIXTURE])(
    "normalizes a saved v2 ingestion plan to the compatibility chart metric",
    async ({ data }) => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data }));
      const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
      const points = await client.getUserPnl(wallet, {
        interval: data.interval,
        fidelity: data.fidelity,
      });

      expect(points).toEqual(
        data.points.map(({ timestamp, trade_pnl }) => ({
          t: timestamp,
          p: trade_pnl,
        }))
      );
      expect(data.points.some((p) => p.trade_pnl !== p.economic_pnl)).toBe(
        true
      );
      const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
      expect(url.origin + url.pathname).toBe(
        "https://data-api.polymarket.com/v2/user-pnl"
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        user: wallet,
        interval: data.interval,
        fidelity: data.fidelity,
      });
    }
  );

  it("accepts the upstream default hourly grid and case-insensitive wallet identity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(WEEK_FIXTURE));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    await expect(
      client.getUserPnl(`0x${wallet.slice(2).toUpperCase()}`, {
        interval: "1w",
      })
    ).resolves.toHaveLength(WEEK_FIXTURE.data.points.length);
  });

  it.each([
    { proxy_wallet: "0x0000000000000000000000000000000000000000" },
    { interval: "all" },
    { fidelity: "1d" },
  ])("rejects a mismatched response identity: %j", async (mismatch) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { ...WEEK_FIXTURE.data, ...mismatch },
      })
    );
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    await expect(client.getUserPnl(wallet, weeklyParams)).rejects.toThrow(
      /identity mismatch/
    );
  });

  it.each([
    null,
    { data: null },
    [],
    { data: { ...WEEK_FIXTURE.data, points: null } },
    { data: { ...WEEK_FIXTURE.data, source_fidelity: null } },
  ])("rejects malformed or null response envelopes", async (body) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    await expect(client.getUserPnl(wallet, weeklyParams)).rejects.toThrow();
  });

  it.each([
    { timestamp: 1791547200, trade_pnl: null },
    { timestamp: 1791547200 },
    { timestamp: 1791547200, trade_pnl: "1.5" },
    { timestamp: 1791547200, trade_pnl: Number.NaN },
    { timestamp: 1791547200, trade_pnl: Number.POSITIVE_INFINITY },
    { timestamp: null, trade_pnl: 1.5 },
    { timestamp: -1, trade_pnl: 1.5 },
    { timestamp: 1.5, trade_pnl: 1.5 },
  ])("rejects unavailable or malformed chart facts: %j", async (point) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { ...WEEK_FIXTURE.data, points: [point] },
      })
    );
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const info = vi.fn();
    const warn = vi.fn();
    await expect(
      client.getUserPnl(wallet, weeklyParams, { logger: { info, warn } })
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "poly.user-pnl.result",
      outcome: "error",
    });
  });

  it("keeps normalized points strict instead of coercing null into zero", () => {
    expect(
      PolymarketUserPnlPointSchema.safeParse({ t: 1, p: null }).success
    ).toBe(false);
    expect(
      PolymarketUserPnlPointSchema.safeParse({ t: null, p: 1 }).success
    ).toBe(false);
    expect(PolymarketUserPnlPointSchema.safeParse({ t: 1, p: 0 }).success).toBe(
      true
    );
  });

  it("reports one terminal successful outcome as well as the attempt", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(WEEK_FIXTURE));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const info = vi.fn();
    const warn = vi.fn();
    await client.getUserPnl(wallet, weeklyParams, {
      logger: { info, warn },
      component: "trader-observation",
    });
    expect(info.mock.calls.map((c) => c[0].event)).toEqual([
      "poly.user-pnl.outbound",
      "poly.user-pnl.result",
    ]);
    expect(info.mock.calls[1]?.[0]).toMatchObject({
      outcome: "ok",
      component: "trader-observation",
      wallet,
      points: WEEK_FIXTURE.data.points.length,
      duration_ms: expect.any(Number),
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a failed fetch via warn and still rethrows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 502));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const info = vi.fn();
    const warn = vi.fn();
    await expect(
      client.getUserPnl(wallet, weeklyParams, { logger: { info, warn } })
    ).rejects.toThrow(/502/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "poly.user-pnl.result",
      outcome: "error",
      err: expect.stringContaining("502"),
    });
  });

  it("falls back to info when the logger has no warn", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 500));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const info = vi.fn();
    await expect(
      client.getUserPnl(wallet, weeklyParams, { logger: { info } })
    ).rejects.toThrow(/500/);
    expect(
      info.mock.calls.filter(
        (c) => c[0].event === "poly.user-pnl.result" && c[0].outcome === "error"
      )
    ).toHaveLength(1);
  });

  it("supports empty histories without fabricating points", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { ...WEEK_FIXTURE.data, points: [] },
      })
    );
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    await expect(client.getUserPnl(wallet, weeklyParams)).resolves.toEqual([]);
  });

  it("rejects malformed wallet addresses before fetching", async () => {
    const fetchImpl = vi.fn();
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    await expect(
      client.getUserPnl("not-a-wallet", weeklyParams)
    ).rejects.toThrow(/Invalid wallet/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps caller cancellation distinct and reports its terminal outcome", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const warn = vi.fn();
    await expect(
      client.getUserPnl(wallet, weeklyParams, {
        signal: controller.signal,
        logger: { info: vi.fn(), warn },
      })
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
