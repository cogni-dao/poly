// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/polymarket-user-pnl`
 * Purpose: Unit tests for the Polymarket user P/L client backed by saved live fixtures.
 * Scope: Injected fetch mock only. Does not perform live network I/O or mutate state.
 * Invariants:
 *   - EMPTY_IS_HONEST: an upstream empty array stays empty.
 *   - QUERY_SHAPE_STABLE: requests keep `user_address`, `interval`, and `fidelity`.
 * Side-effects: none
 * Links: docs/research/fixtures/polymarket-user-pnl-week.json
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

const WEEK_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "fixtures/polymarket-user-pnl-week.json"
    ),
    "utf8"
  )
) as unknown[];

const EMPTY_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "fixtures/polymarket-user-pnl-empty.json"
    ),
    "utf8"
  )
) as unknown[];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

describe("PolymarketUserPnlClient.getUserPnl", () => {
  const wallet = "0x492442eab586f242b53bda933fd5de859c8a3782";

  it("parses the saved weekly fixture without throwing", () => {
    const parsed = WEEK_FIXTURE.map((row) =>
      PolymarketUserPnlPointSchema.parse(row)
    );
    expect(parsed.length).toBeGreaterThanOrEqual(2);
    expect(parsed[0]?.t).toBeTypeOf("number");
    expect(parsed[0]?.p).toBeTypeOf("number");
  });

  it("hits /user-pnl with user_address, interval, and fidelity", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(WEEK_FIXTURE));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });

    const points = await client.getUserPnl(wallet, {
      interval: "1w",
      fidelity: "1d",
    });

    expect(points).toHaveLength(WEEK_FIXTURE.length);
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("/user-pnl");
    expect(call).toContain(`user_address=${wallet}`);
    expect(call).toContain("interval=1w");
    expect(call).toContain("fidelity=1d");
  });

  it("logs the OUTCOME of a fetch, not just the attempt (bug.5306)", async () => {
    // Prod emitted 120 `outbound` lines in 11min with no way to tell a healthy
    // P/L feed from a dead one — success had to be inferred from the observation
    // job's insert counts, one layer up and one job away.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(WEEK_FIXTURE));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const info = vi.fn();
    const warn = vi.fn();

    await client.getUserPnl(
      wallet,
      { interval: "1w", fidelity: "1d" },
      { logger: { info, warn }, component: "trader-observation" }
    );

    const events = info.mock.calls.map((c) => c[0].event);
    expect(events).toContain("poly.user-pnl.outbound");
    expect(events).toContain("poly.user-pnl.result");
    const result = info.mock.calls.find(
      (c) => c[0].event === "poly.user-pnl.result"
    )?.[0];
    expect(result).toMatchObject({
      outcome: "ok",
      component: "trader-observation",
      wallet,
      interval: "1w",
      points: WEEK_FIXTURE.length,
    });
    expect(result.duration_ms).toBeTypeOf("number");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a failed fetch via warn, and still rethrows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      json: async () => ({}),
    });
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const info = vi.fn();
    const warn = vi.fn();

    await expect(
      client.getUserPnl(
        wallet,
        { interval: "all" },
        { logger: { info, warn }, component: "trader-observation" }
      )
    ).rejects.toThrow(/502/);

    // The caller still sees the throw; the log is additive, not a swallow.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "poly.user-pnl.result",
      outcome: "error",
    });
    expect(String(warn.mock.calls[0]?.[0].err)).toContain("502");
  });

  it("falls back to info when the logger has no warn", async () => {
    // A minimal logger must not silently drop the outcome.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Server Error",
      json: async () => ({}),
    });
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    const info = vi.fn();

    await expect(
      client.getUserPnl(wallet, { interval: "all" }, { logger: { info } })
    ).rejects.toThrow(/500/);

    const errEvents = info.mock.calls.filter(
      (c) => c[0].event === "poly.user-pnl.result" && c[0].outcome === "error"
    );
    expect(errEvents).toHaveLength(1);
  });

  it("supports empty histories without fabricating points", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(EMPTY_FIXTURE));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });

    await expect(
      client.getUserPnl(wallet, { interval: "1w", fidelity: "1d" })
    ).resolves.toEqual([]);
  });

  it("rejects malformed wallet addresses", async () => {
    const fetchImpl = vi.fn();
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    await expect(
      client.getUserPnl("not-a-wallet", { interval: "1w" })
    ).rejects.toThrow(/Invalid wallet/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a clear error on non-OK HTTP", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 503));
    const client = new PolymarketUserPnlClient({ fetch: fetchImpl });
    await expect(
      client.getUserPnl(wallet, { interval: "1w", fidelity: "1d" })
    ).rejects.toThrow(/503/);
  });
});
