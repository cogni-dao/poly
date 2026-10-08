// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/polymarket-data-api`
 * Purpose: Unit tests for the Polymarket Data API client — leaderboard, user trades, user positions.
 * Scope: Uses an injected fetch mock + the saved fixture JSON. Does not perform live network I/O, does not mutate state.
 * Invariants: TS_ONLY_RUNTIME, CONTRACT_IS_SOT.
 * Side-effects: none
 * Links: work/items/task.0315.poly-copy-trade-prototype.md, docs/research/fixtures/polymarket-leaderboard.json
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PolyDataApiValidationError,
  PolymarketDataApiClient,
  PolymarketLeaderboardEntrySchema,
} from "../src/adapters/polymarket/index.js";
import {
  __polyDataApiInflightForTests,
  __polyDataApiSlotsForTests,
  __resetPolyDataApiCooldownForTests,
  parseRetryAfterMs,
  PolyDataApiRateLimitedError,
} from "../src/adapters/polymarket/polymarket.data-api.client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEADERBOARD_FIXTURE = JSON.parse(
  readFileSync(
    path.resolve(
      __dirname,
      "fixtures/polymarket-leaderboard.json"
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

describe("PolymarketDataApiClient.listTopTraders", () => {
  it("parses the saved leaderboard fixture without throwing", () => {
    const parsed = LEADERBOARD_FIXTURE.map((row) =>
      PolymarketLeaderboardEntrySchema.parse(row)
    );
    expect(parsed.length).toBeGreaterThanOrEqual(10);
    const first = parsed[0];
    if (!first) throw new Error("fixture is empty");
    expect(first.proxyWallet).toMatch(/^0x[a-f0-9]{40}$/);
    expect(typeof first.pnl).toBe("number");
    expect(typeof first.vol).toBe("number");
  });

  it("hits /v1/leaderboard with timePeriod + orderBy + limit and returns parsed entries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(LEADERBOARD_FIXTURE));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const entries = await client.listTopTraders({
      timePeriod: "DAY",
      orderBy: "PNL",
      limit: 10,
    });

    expect(entries).toHaveLength(LEADERBOARD_FIXTURE.length);
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("/v1/leaderboard");
    expect(call).toContain("timePeriod=DAY");
    expect(call).toContain("orderBy=PNL");
    expect(call).toContain("limit=10");
  });

  it("defaults to timePeriod=WEEK, orderBy=PNL, limit=10 when params omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await client.listTopTraders();
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("timePeriod=WEEK");
    expect(call).toContain("orderBy=PNL");
    expect(call).toContain("limit=10");
  });

  it("throws a clear error on non-OK HTTP", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 503));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listTopTraders()).rejects.toThrow(/503/);
  });

  it("throws on schema mismatch (fails closed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ rank: 1, wallet: "oops" }]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listTopTraders()).rejects.toThrow();
  });

  it("aborts and throws a timeout error when the upstream stalls past timeoutMs", async () => {
    // fetchImpl respects AbortSignal: rejects with an AbortError when the
    // controller fires. Without the timeout wrapper, this promise would hang
    // indefinitely — which is exactly the production failure mode that ate
    // 8-minute dashboard requests in dev.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })
    );
    const client = new PolymarketDataApiClient({
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 20,
    });
    await expect(client.listTopTraders()).rejects.toThrow(/timeout after 20ms/);
  });
});

describe("PolymarketDataApiClient.listUserActivity", () => {
  const wallet = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";

  it("hits /trades?user=<wallet> and returns parsed trades", async () => {
    const body = [
      {
        proxyWallet: wallet,
        side: "BUY",
        asset: "48392",
        conditionId: "0xabc",
        size: 100,
        price: 0.75,
        timestamp: 1776353664,
        title: "Some market",
        outcome: "Yes",
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const trades = await client.listUserActivity(wallet);
    expect(trades).toHaveLength(1);
    expect(trades[0]?.price).toBe(0.75);
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("/trades?user=");
    expect(call).toContain(wallet);
  });

  it("filters by sinceTs", async () => {
    const body = [
      {
        proxyWallet: wallet,
        side: "BUY",
        asset: "a",
        conditionId: "c",
        size: 1,
        price: 0.5,
        timestamp: 1000,
      },
      {
        proxyWallet: wallet,
        side: "SELL",
        asset: "a",
        conditionId: "c",
        size: 1,
        price: 0.6,
        timestamp: 3000,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const trades = await client.listUserActivity(wallet, { sinceTs: 2000 });
    expect(trades).toHaveLength(1);
    expect(trades[0]?.timestamp).toBe(3000);
  });

  it("excludes the boundary timestamp from sinceTs (strict >, not >=) — bug.0426", async () => {
    const body = [
      {
        proxyWallet: wallet,
        side: "BUY",
        asset: "a",
        conditionId: "c",
        size: 1,
        price: 0.5,
        timestamp: 1000,
      },
      {
        proxyWallet: wallet,
        side: "BUY",
        asset: "a",
        conditionId: "c",
        size: 1,
        price: 0.5,
        timestamp: 1001,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const trades = await client.listUserActivity(wallet, { sinceTs: 1000 });
    expect(trades).toHaveLength(1);
    expect(trades[0]?.timestamp).toBe(1001);
  });

  it("rejects malformed wallet addresses", async () => {
    const fetchImpl = vi.fn();
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listUserActivity("not-a-wallet")).rejects.toThrow(
      /Invalid wallet/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("PolymarketDataApiClient.listUserPositions", () => {
  const wallet = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";

  it("hits /positions?user=<wallet> and returns parsed positions", async () => {
    const body = [
      {
        proxyWallet: wallet,
        asset: "x",
        conditionId: "c",
        size: 10,
        avgPrice: 0.4,
        initialValue: 4,
        currentValue: 8,
        cashPnl: 4,
        percentPnl: 100,
        realizedPnl: 0,
        curPrice: 0.8,
        redeemable: false,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const positions = await client.listUserPositions(wallet);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.cashPnl).toBe(4);
  });

  it("forwards sizeThreshold + offset when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await client.listUserPositions(wallet, {
      sizeThreshold: 100,
      limit: 25,
      offset: 50,
    });
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("sizeThreshold=100");
    expect(call).toContain("limit=25");
    expect(call).toContain("offset=50");
  });
});

describe("PolymarketDataApiClient.listAllUserPositions", () => {
  const wallet = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";

  function makePosition(asset: string) {
    return {
      proxyWallet: wallet,
      asset,
      conditionId: `c-${asset}`,
      size: 1,
      avgPrice: 0.5,
      initialValue: 0.5,
      currentValue: 0.5,
      cashPnl: 0,
      percentPnl: 0,
      realizedPnl: 0,
      curPrice: 0.5,
      redeemable: false,
    };
  }

  it("walks pages until a short page is returned and concatenates rows", async () => {
    const fullPage = Array.from({ length: 500 }, (_, i) => makePosition(`a${i}`));
    const tailPage = Array.from({ length: 17 }, (_, i) => makePosition(`b${i}`));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse(tailPage));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const all = await client.listAllUserPositions(wallet);

    expect(all).toHaveLength(517);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = fetchImpl.mock.calls[0]?.[0] as string;
    const secondUrl = fetchImpl.mock.calls[1]?.[0] as string;
    expect(firstUrl).toContain("limit=500");
    expect(firstUrl).toContain("offset=0");
    expect(secondUrl).toContain("limit=500");
    expect(secondUrl).toContain("offset=500");
  });

  it("stops at the first page when fewer than PAGE_SIZE rows are returned", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([makePosition("only")]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const all = await client.listAllUserPositions(wallet);

    expect(all).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns [] when the wallet holds no positions", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    expect(await client.listAllUserPositions(wallet)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("forwards baseParams (sizeThreshold) on every page", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await client.listAllUserPositions(wallet, { sizeThreshold: 5 });
    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(url).toContain("sizeThreshold=5");
    expect(url).toContain("limit=500");
    expect(url).toContain("offset=0");
  });

  it("defaults sizeThreshold=0 so sub-dollar positions are not silently omitted", async () => {
    // Polymarket's /positions endpoint applies a non-zero default threshold
    // server-side. Without an explicit `sizeThreshold=0`, winning positions
    // with `currentValue < ~$1` are dropped from the response — leaving the
    // redeem-diff blind to them and stranding them indefinitely.
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await client.listAllUserPositions(wallet);
    const url = fetchImpl.mock.calls[0]?.[0] as string;
    expect(url).toContain("sizeThreshold=0");
  });
});

describe("PolymarketDataApiClient.listUserPositionsV2", () => {
  const wallet = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";
  const condition = (suffix: number) =>
    `0x${suffix.toString(16).padStart(64, "0")}`;
  const makePosition = (
    conditionId: string,
    tokenId: string,
    overrides: Record<string, unknown> = {}
  ) => ({
    archived: false,
    avg_price: 0.4,
    condition_id: conditionId,
    current_price: 0.8,
    current_size: 10,
    current_value: 8,
    end_date: "2026-12-31T00:00:00Z",
    entry_cost_usdc: 4,
    entry_fees_usdc: 0,
    event_id: "event-1",
    event_slug: "event-slug",
    first_entry_at: 1_700_000_000,
    icon: null,
    last_event_at: 1_700_000_100,
    mergeable: false,
    name: null,
    negative_risk: false,
    opposite_outcome: "NO",
    opposite_token_id: "999",
    outcome: "YES",
    outcome_index: 0,
    percent_pnl: 100,
    percent_realized_pnl: 0,
    profile_image: null,
    proxy_wallet: wallet,
    realized_pnl: 0,
    redeemable: false,
    slug: "market-slug",
    status: "OPEN",
    title: "Market title",
    token_id: tokenId,
    total_cost_usdc: 4,
    total_pnl: 4,
    total_size: 10,
    unrealized_pnl: 4,
    verified: false,
    ...overrides,
  });
  const page = (data: unknown[], nextCursor: string | null = null) => ({
    data,
    pagination: {
      has_more: nextCursor !== null,
      limit: 1000,
      offset: 0,
      next_cursor: nextCursor,
    },
  });

  it("chunks 21 conditions, follows cursors, and normalizes V2 economics", async () => {
    const conditions = Array.from({ length: 21 }, (_, index) =>
      condition(index + 1)
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(page([makePosition(conditions[0] ?? "", "11")], "cursor-2"))
      )
      .mockResolvedValueOnce(
        jsonResponse(
          page([
            makePosition(conditions[19] ?? "", "22", {
              status: "REDEEMABLE",
              redeemable: true,
              current_price: 0,
              current_value: 0,
              entry_cost_usdc: 5,
              unrealized_pnl: -5,
              percent_pnl: -100,
            }),
          ])
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(page([makePosition(conditions[20] ?? "", "33")]))
      );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const positions = await client.listUserPositionsV2(wallet, { conditions });

    expect(positions).toHaveLength(3);
    expect(positions[0]).toMatchObject({
      conditionId: conditions[0],
      asset: "11",
      size: 10,
      avgPrice: 0.4,
      initialValue: 4,
      currentValue: 8,
      cashPnl: 4,
    });
    expect(positions[1]).toMatchObject({
      conditionId: conditions[19],
      asset: "22",
      initialValue: 5,
      currentValue: 0,
      redeemable: true,
    });
    const urls = fetchImpl.mock.calls.map((call) => call[0] as string);
    const first = new URL(urls[0] ?? "");
    const second = new URL(urls[1] ?? "");
    const third = new URL(urls[2] ?? "");
    expect(first.pathname).toBe("/v2/positions");
    expect(first.searchParams.get("condition")?.split(",")).toHaveLength(20);
    expect(first.searchParams.get("status")).toBe("OPEN");
    expect(first.searchParams.get("include_archived")).toBe("true");
    expect(first.searchParams.get("filter_type")).toBe("TOKENS");
    expect(first.searchParams.get("filter_amount")).toBe("0");
    expect(second.searchParams.get("condition")).toBe(
      first.searchParams.get("condition")
    );
    expect(second.searchParams.get("cursor")).toBe("cursor-2");
    expect(second.searchParams.has("limit")).toBe(false);
    expect(third.searchParams.get("condition")).toBe(conditions[20]);
  });

  it("rejects duplicate condition/token rows across a cursor walk", async () => {
    const row = makePosition(condition(1), "11");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page([row], "cursor-2")))
      .mockResolvedValueOnce(jsonResponse(page([row])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(
      client.listUserPositionsV2(wallet, { conditions: [condition(1)] })
    ).rejects.toThrow(/duplicate position key/);
  });

  it("rejects mismatched cohorts, malformed pagination, and statuses outside an OPEN walk", async () => {
    const mismatched = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(page([makePosition(condition(2), "11")]))
      ),
    });
    await expect(
      mismatched.listUserPositionsV2(wallet, { conditions: [condition(1)] })
    ).rejects.toThrow(/outside the requested cohort/);

    const malformed = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse({
          data: [makePosition(condition(1), "11")],
          pagination: {
            has_more: true,
            limit: 1000,
            offset: 0,
            next_cursor: null,
          },
        })
      ),
    });
    await expect(
      malformed.listUserPositionsV2(wallet, { conditions: [condition(1)] })
    ).rejects.toBeInstanceOf(PolyDataApiValidationError);

    const wrongStatus = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          page([makePosition(condition(1), "11", { status: "CLOSED" })])
        )
      ),
    });
    await expect(
      wrongStatus.listUserPositionsV2(wallet, { conditions: [condition(1)] })
    ).rejects.toThrow(/response status CLOSED was outside the requested OPEN cohort/);

    const queryOnlyStatus = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          page([makePosition(condition(1), "11", { status: "MERGEABLE" })])
        )
      ),
    });
    await expect(
      queryOnlyStatus.listUserPositionsV2(wallet, {
        conditions: [condition(1)],
      })
    ).rejects.toBeInstanceOf(PolyDataApiValidationError);

    const unknownStatus = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse(
          page([makePosition(condition(1), "11", { status: "SETTLED" })])
        )
      ),
    });
    await expect(
      unknownStatus.listUserPositionsV2(wallet, {
        conditions: [condition(1)],
      })
    ).rejects.toBeInstanceOf(PolyDataApiValidationError);
  });

  it("discovers positive OPEN positions with a bounded unscoped CASH cursor walk", async () => {
    const open = makePosition(condition(1), "11");
    const redeemable = makePosition(condition(2), "22", {
      status: "REDEEMABLE",
      redeemable: true,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page([open], "cursor-2")))
      .mockResolvedValueOnce(jsonResponse(page([redeemable])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const result = await client.listPositiveOpenUserPositionsV2(wallet);

    expect(result.positions).toEqual([open]);
    expect(result.requestCount).toBe(2);
    const urls = fetchImpl.mock.calls.map((call) => new URL(call[0] as string));
    expect(urls[0]?.searchParams.has("condition")).toBe(false);
    expect(urls[0]?.searchParams.get("filter_type")).toBe("CASH");
    expect(urls[0]?.searchParams.get("include_archived")).toBe("false");
    expect(Number(urls[0]?.searchParams.get("filter_amount"))).toBeGreaterThan(
      0
    );
    expect(urls[1]?.searchParams.get("cursor")).toBe("cursor-2");
  });

  it("rejects an archived row leaked into active target-book discovery", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        page([makePosition(condition(1), "11", { archived: true })])
      )
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(
      client.listPositiveOpenUserPositionsV2(wallet)
    ).rejects.toThrow(/archived token/);
  });

  it("fails before exceeding the positive discovery request budget", async () => {
    let cursor = 0;
    const fetchImpl = vi.fn().mockImplementation(() => {
      cursor += 1;
      return Promise.resolve(
        jsonResponse(page([], `cursor-${cursor}`))
      );
    });
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(
      client.listPositiveOpenUserPositionsV2(wallet)
    ).rejects.toThrow(/request budget/);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("walks unscoped V2 TOKENS positions for redemption reads", async () => {
    const winner = makePosition(condition(1), "11", {
      status: "REDEEMABLE",
      redeemable: true,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(page([winner], "cursor-2")))
      .mockResolvedValueOnce(jsonResponse(page([])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const positions = await client.listAllUserPositionsV2(wallet);

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      conditionId: condition(1),
      asset: "11",
      redeemable: true,
    });
    const first = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(first.searchParams.has("condition")).toBe(false);
    expect(first.searchParams.get("filter_type")).toBe("TOKENS");
    expect(first.searchParams.get("filter_amount")).toBe("0");
  });
});

describe("PolymarketDataApiClient.getStatusV2", () => {
  it("parses source freshness evidence from /v2/status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          computed_at: "2026-10-08T02:43:37Z",
          age_seconds: 8,
          serving: {
            lag_seconds: 1,
            worst: "activity_feed",
            mechanisms: [
              {
                name: "custody_balances",
                age_seconds: 0,
                blocks_behind: 0,
              },
              { name: "pnl", age_seconds: 0, blocks_behind: 1 },
            ],
          },
          ingestion: {
            cursors: 175,
            network: "polygon",
            chain_id: 137,
            max_synced_block: 95_148_145,
          },
        },
      })
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(client.getStatusV2()).resolves.toMatchObject({
      computed_at: "2026-10-08T02:43:37Z",
      ingestion: { chain_id: 137, max_synced_block: 95_148_145 },
    });
    expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).pathname).toBe(
      "/v2/status"
    );
  });

  it("rejects malformed freshness evidence", async () => {
    const client = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(jsonResponse({ data: {} })),
    });
    await expect(client.getStatusV2()).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
  });
});

describe("PolymarketDataApiClient.listActivity", () => {
  const wallet = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";

  it("hits /activity with type/side/start/end/limit/offset and parses the response", async () => {
    const body = [
      {
        proxyWallet: wallet,
        type: "TRADE",
        side: "BUY",
        timestamp: 1776000000,
        size: 10,
        price: 0.5,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const events = await client.listActivity(wallet, {
      type: "TRADE",
      side: "BUY",
      start: 1770000000,
      end: 1780000000,
      limit: 50,
      offset: 0,
    });
    expect(events).toHaveLength(1);
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("/activity?user=");
    expect(call).toContain("type=TRADE");
    expect(call).toContain("side=BUY");
    expect(call).toContain("start=1770000000");
    expect(call).toContain("end=1780000000");
    expect(call).toContain("limit=50");
  });

  it("throws on schema mismatch (fails closed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ totally: "wrong" }]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listActivity(wallet)).rejects.toThrow();
  });

  it("rejects malformed wallet addresses", async () => {
    const fetchImpl = vi.fn();
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listActivity("not-a-wallet")).rejects.toThrow(
      /Invalid wallet/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("PolymarketDataApiClient.getValue", () => {
  const wallet = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";

  it("returns the first `{ user, value }` entry from /value", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse([{ user: wallet, value: 123.45 }]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const result = await client.getValue(wallet, { market: "0xabc" });
    expect(result.user).toBe(wallet);
    expect(result.value).toBeCloseTo(123.45);
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("/value?user=");
    expect(call).toContain("market=0xabc");
  });

  it("returns zero when the endpoint yields an empty array", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const result = await client.getValue(wallet);
    expect(result.value).toBe(0);
  });
});

describe("PolymarketDataApiClient.getHolders", () => {
  it("hits /holders?market=<id>&limit and returns parsed holders", async () => {
    const body = [
      {
        proxyWallet: "0xAAA",
        outcomeIndex: 0,
        outcome: "Yes",
        amount: 500,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const holders = await client.getHolders("0xCONDITION", { limit: 10 });
    expect(holders).toHaveLength(1);
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("/holders?market=0xCONDITION");
    expect(call).toContain("limit=10");
  });

  it("throws on empty market", async () => {
    const client = new PolymarketDataApiClient({ fetch: vi.fn() });
    await expect(client.getHolders("")).rejects.toThrow(/market/);
  });
});

describe("PolymarketDataApiClient.listMarketTrades", () => {
  it("hits /trades?market=<id> (no user) and sets takerOnly", async () => {
    const body = [
      {
        proxyWallet: "0xTAKER",
        makerAddress: "0xMAKER",
        side: "BUY",
        asset: "a",
        conditionId: "c",
        size: 10,
        price: 0.5,
        timestamp: 1776000000,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const trades = await client.listMarketTrades("0xCONDITION", {
      takerOnly: true,
      limit: 50,
      offset: 0,
    });
    expect(trades).toHaveLength(1);
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("/trades?market=0xCONDITION");
    expect(call).toContain("takerOnly=true");
    expect(call).not.toContain("user=");
  });
});

describe("PolymarketDataApiClient.resolveUsername", () => {
  it("hits Gamma /public-search with profile=true and returns profiles[]", async () => {
    const body = {
      profiles: [
        {
          name: "alice",
          proxyWallet: "0xABC",
          displayUsername: "alice",
        },
      ],
      events: [],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const profiles = await client.resolveUsername("alice", { limit: 5 });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.proxyWallet).toBe("0xABC");
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("gamma-api.polymarket.com");
    expect(call).toContain("/public-search");
    expect(call).toContain("q=alice");
    expect(call).toContain("profile=true");
    expect(call).toContain("limit=5");
  });

  it("uses a custom gammaBaseUrl when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ profiles: [] }));
    const client = new PolymarketDataApiClient({
      fetch: fetchImpl,
      gammaBaseUrl: "http://fake-gamma.test",
    });
    await client.resolveUsername("bob");
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("fake-gamma.test");
  });

  it("rejects queries shorter than 2 chars", async () => {
    const client = new PolymarketDataApiClient({ fetch: vi.fn() });
    await expect(client.resolveUsername("a")).rejects.toThrow(/≥2/);
  });
});

describe("PolymarketDataApiClient.resolveTokenMetadata", () => {
  const tokenId = "686203923426123";
  const conditionId = `0x${"ab".repeat(32)}`;

  it("maps one exact CLOB token to the aligned Gamma outcome", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          conditionId,
          question: "Player A vs Player B",
          slug: "player-a-v-player-b",
          endDate: "2026-10-09T00:00:00Z",
          outcomes: '["Player A","Player B"]',
          clobTokenIds: `["${tokenId}","999"]`,
        },
      ])
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(client.resolveTokenMetadata(tokenId)).resolves.toEqual({
      conditionId,
      outcome: "Player A",
      endDate: "2026-10-09T00:00:00Z",
      title: "Player A vs Player B",
      slug: "player-a-v-player-b",
    });
    const call = fetchImpl.mock.calls[0]?.[0] as string;
    expect(call).toContain("gamma-api.polymarket.com/markets");
    expect(call).toContain(`clob_token_ids=${tokenId}`);
    expect(call).toContain("limit=2");
  });

  it("fails closed on duplicate markets or misaligned legs", async () => {
    const matching = {
      conditionId,
      outcomes: '["YES","NO"]',
      clobTokenIds: `["${tokenId}","999"]`,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([matching, matching]))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            conditionId,
            outcomes: '["YES"]',
            clobTokenIds: `["${tokenId}","999"]`,
          },
        ])
      );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(client.resolveTokenMetadata(tokenId)).resolves.toBeNull();
    await expect(client.resolveTokenMetadata(tokenId)).resolves.toBeNull();
  });

  it("fails closed when one valid row is accompanied by a malformed duplicate", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          conditionId,
          outcomes: '["YES","NO"]',
          clobTokenIds: `["${tokenId}","999"]`,
        },
        {
          conditionId,
          outcomes: '["YES"]',
          clobTokenIds: `["${tokenId}","999"]`,
        },
      ])
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(client.resolveTokenMetadata(tokenId)).resolves.toBeNull();
  });

  it("still reaches Gamma while a Data API 429 cooldown is open", async () => {
    __resetPolyDataApiCooldownForTests();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, false, 429))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            conditionId,
            outcomes: '["YES","NO"]',
            clobTokenIds: `["${tokenId}","999"]`,
          },
        ])
      );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await expect(
      client.listUserPositions("0x9f2fe025f84839ca81dd8e0338892605702d2ca8")
    ).rejects.toThrow(/429/);
    await expect(client.resolveTokenMetadata(tokenId)).resolves.toMatchObject({
      conditionId,
      outcome: "YES",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    __resetPolyDataApiCooldownForTests();
  });
});

describe("PolymarketDataApiClient Zod envelope", () => {
  const wallet = "0x1234567890abcdef1234567890abcdef12345678";

  it("throws PolyDataApiValidationError with endpoint + issues when /activity response is malformed", async () => {
    // Missing required `proxyWallet` on the event — should fail the envelope parse.
    const malformed = [{ type: "TRADE", timestamp: 1700000000 }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(malformed));
    const client = new PolymarketDataApiClient({
      fetch: fetchImpl,
      baseUrl: "http://fake.test",
    });
    await expect(client.listActivity(wallet)).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
    try {
      await client.listActivity(wallet);
    } catch (err) {
      expect(err).toBeInstanceOf(PolyDataApiValidationError);
      const typed = err as PolyDataApiValidationError;
      expect(typed.code).toBe("VALIDATION_FAILED");
      expect(typed.endpoint).toBe("/activity");
      expect(typed.issues.length).toBeGreaterThan(0);
    }
  });

  it("throws PolyDataApiValidationError when /holders returns a non-array", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "not an array" }));
    const client = new PolymarketDataApiClient({
      fetch: fetchImpl,
      baseUrl: "http://fake.test",
    });
    await expect(
      client.getHolders("0xabc", { limit: 10 })
    ).rejects.toBeInstanceOf(PolyDataApiValidationError);
  });
});

describe("process-wide 429 cooldown (bug.5284)", () => {
  beforeEach(() => {
    __resetPolyDataApiCooldownForTests();
  });

  it("stops a SECOND client instance from calling after the first is 429'd", async () => {
    // The whole point: the app builds 7+ independent clients, but Polymarket
    // limits per-IP. Per-instance state cannot see the limit another instance
    // just tripped — which is why per-job breakers for wallet-watch (bug.5276)
    // and top-wallet-stats (bug.5283) still left a third caller 429ing.
    const firstFetch = vi.fn(async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const secondFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      json: async () => [],
    })) as unknown as typeof fetch;

    const a = new PolymarketDataApiClient({ fetch: firstFetch });
    await expect(a.listUserActivity("0x2005d16a84ceefa912d4e380cd32e7ff827875ea")).rejects.toThrow(/429/);

    const b = new PolymarketDataApiClient({ fetch: secondFetch });
    await expect(b.listUserActivity("0x2005d16a84ceefa912d4e380cd32e7ff827875ea")).rejects.toThrow(
      PolyDataApiRateLimitedError
    );
    // The decisive assertion — the second client never issued a request.
    expect(secondFetch).not.toHaveBeenCalled();
  });

  it("honours Retry-After and caps it so a bad header cannot wedge reads", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs(null)).toBe(5000);
    expect(parseRetryAfterMs("garbage")).toBe(5000);
    expect(parseRetryAfterMs("-5")).toBe(5000);
    expect(parseRetryAfterMs("99999")).toBe(30000);
  });
});

describe("process-wide in-flight cap (bug.5286)", () => {
  beforeEach(() => {
    __resetPolyDataApiCooldownForTests();
  });

  it("caps concurrent upstream requests across INSTANCES, so a burst cannot all reach upstream", async () => {
    // Prod 08cedd2 showed 429s arriving in SAME-MILLISECOND clusters: the herd
    // was already in flight when the first 429 returned, so the cooldown closed
    // behind them. Capping in-flight is the only thing that bounds the head.
    let peak = 0;
    let concurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl = (async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await gate;
      concurrent -= 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => [],
      };
    }) as unknown as typeof fetch;

    // Six requests spread over three DIFFERENT client instances — the real
    // shape, since the app constructs one client per consumer.
    const clients = [0, 1, 2].map(
      () => new PolymarketDataApiClient({ fetch: fetchImpl })
    );
    const wallets = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
    const calls = clients.flatMap((c) => [
      c.listUserActivity(wallets),
      c.listUserActivity(wallets),
    ]);

    await vi.waitFor(() => expect(peak).toBeGreaterThan(0));
    expect(__polyDataApiInflightForTests().queued).toBeGreaterThan(0);
    release();
    await Promise.all(calls);

    // The assertion that matters: upstream never saw more than the cap at once.
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("abandons a QUEUED request when the caller aborts, instead of calling upstream anyway (bug.5297)", async () => {
    // The wallet_loop hang: the tick's 120s timeout fires while a read is
    // parked in the slot queue. Before this fix the waiter stayed parked, then
    // issued its request after the tick had already been abandoned, so the
    // tick could not settle and upstream was hit for nothing.
    let upstreamCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchImpl = (async () => {
      upstreamCalls += 1;
      await gate;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => [],
      };
    }) as unknown as typeof fetch;

    const c = new PolymarketDataApiClient({ fetch: fetchImpl });
    const w = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
    // Saturate the cap, then queue one more behind it with its own signal.
    const inflight = [c.listUserActivity(w), c.listUserActivity(w)];
    const controller = new AbortController();
    const queued = c.listUserActivity(w, { signal: controller.signal });

    await vi.waitFor(() =>
      expect(__polyDataApiInflightForTests().queued).toBe(1)
    );
    expect(upstreamCalls).toBe(2);

    controller.abort();
    // It rejects promptly — without waiting for a slot it will never use.
    await expect(queued).rejects.toThrow(/aborted by caller while queued/);
    expect(upstreamCalls).toBe(2);
    expect(__polyDataApiInflightForTests().queued).toBe(0);

    release();
    await Promise.all(inflight);
    // The abandoned waiter left the accounting clean, so the cap still holds.
    expect(__polyDataApiInflightForTests()).toEqual({ inFlight: 0, queued: 0 });
  });

  it("never exceeds the cap while handing a released slot to a waiter (bug.5286)", async () => {
    // releaseSlot() used to decrement BEFORE resolving the waiter, so for one
    // microtask `inFlight` under-reported by one. A caller arriving in that
    // window saw room and took a third concurrent slot — the cap bug.5286
    // exists to enforce, breached by its own release path.
    const { acquire, release } = __polyDataApiSlotsForTests;
    await acquire();
    await acquire();
    expect(__polyDataApiInflightForTests().inFlight).toBe(2);

    const queued = acquire();
    await vi.waitFor(() =>
      expect(__polyDataApiInflightForTests().queued).toBe(1)
    );

    // Release hands the slot to the waiter; a fresh caller arrives in the SAME
    // synchronous turn, before the waiter's continuation can run.
    release();
    const fresh = acquire();
    await queued;

    expect(__polyDataApiInflightForTests().inFlight).toBeLessThanOrEqual(2);
    expect(__polyDataApiInflightForTests().queued).toBe(1);

    release();
    await fresh;
    release();
    release();
    expect(__polyDataApiInflightForTests()).toEqual({ inFlight: 0, queued: 0 });
  });

  it("does not run out the request timeout when the signal aborts exactly at the slot handoff (bug.5297)", async () => {
    // The one ordering the queue-abort fix cannot reject: releaseSlot() hands
    // this caller the slot synchronously, so it must take it (rejecting would
    // leak the slot) and reaches the fetch already aborted. `addEventListener`
    // does not fire for an already-aborted signal, so without the explicit
    // re-check this request would sit for the full timeoutMs — the same hang,
    // moved one line down.
    const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const fail = (): void =>
          reject(
            Object.assign(new Error("aborted"), { name: "AbortError" })
          );
        // Real fetch checks `aborted` up front; a listener alone would hang.
        if (init.signal.aborted) {
          fail();
          return;
        }
        init.signal.addEventListener("abort", fail, { once: true });
      })) as unknown as typeof fetch;

    const c = new PolymarketDataApiClient({
      fetch: fetchImpl,
      // Long enough that falling through to the timeout would fail the test
      // rather than pass slowly.
      timeoutMs: 60_000,
    });
    const w = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
    const controller = new AbortController();
    // The saturating pair gets its own signal: with `timeoutMs` set to 60s they
    // would otherwise only settle on the timer, long after this test ends.
    const saturating = new AbortController();
    const inflight = [
      c.listUserActivity(w, { signal: saturating.signal }),
      c.listUserActivity(w, { signal: saturating.signal }),
    ];
    const queued = c.listUserActivity(w, { signal: controller.signal });
    await vi.waitFor(() =>
      expect(__polyDataApiInflightForTests().queued).toBe(1)
    );

    // Same synchronous turn: the slot is handed over AND the caller aborts.
    __polyDataApiSlotsForTests.release();
    controller.abort();

    await expect(queued).rejects.toThrow(/aborted by caller/);
    // Slot returned despite the abort, so the cap is not permanently shrunk.
    expect(__polyDataApiInflightForTests().queued).toBe(0);

    saturating.abort();
    const settled = await Promise.allSettled(inflight);
    expect(settled.every((r) => r.status === "rejected")).toBe(true);
    __resetPolyDataApiCooldownForTests();
  });

  it("releases its slot when the cooldown rejects a queued request", async () => {
    // A queued request that finds the cooldown open must not leak its slot,
    // or the cap would permanently shrink after any rate-limit event.
    const fetchImpl = (async () => ({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => null },
      json: async () => ({}),
    })) as unknown as typeof fetch;
    const c = new PolymarketDataApiClient({ fetch: fetchImpl });
    const w = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
    await expect(c.listUserActivity(w)).rejects.toThrow(/429/);
    await expect(c.listUserActivity(w)).rejects.toThrow(
      PolyDataApiRateLimitedError
    );
    expect(__polyDataApiInflightForTests()).toEqual({ inFlight: 0, queued: 0 });
  });
});
