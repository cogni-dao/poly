// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/poly-market-provider/tests/polymarket-data-api`
 * Purpose: Unit tests for the Polymarket Data API v2 client — leaderboard, user trades, user positions, activity, value, holders.
 * Scope: Uses an injected fetch mock + the saved fixture JSON. Does not perform live network I/O, does not mutate state.
 * Invariants: TS_ONLY_RUNTIME, CONTRACT_IS_SOT.
 * Side-effects: none
 * Links: work/items/task.0315.poly-copy-trade-prototype.md, work/items/bug.5049, tests/fixtures/polymarket-leaderboard.json
 * @internal
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PolyDataApiValidationError,
  PolymarketDataApiClient,
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
) as { data: Array<{ rank: number; user_id: string; pnl: number; volume: number }> };

const WALLET = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";
const CONDITION = `0x${"ab".repeat(32)}`;
const TOKEN = "48392";

/** A v2 cursor-paged envelope. */
function v2Page(data: unknown[], nextCursor: string | null = null) {
  return {
    data,
    pagination: {
      has_more: nextCursor !== null,
      limit: 20,
      offset: 0,
      next_cursor: nextCursor,
    },
  };
}

function v2Trade(overrides: Record<string, unknown> = {}) {
  return {
    proxy_wallet: WALLET,
    side: "BUY",
    token_id: TOKEN,
    condition_id: CONDITION,
    size: 100,
    price: 0.75,
    timestamp: 1776353664,
    title: "Some market",
    slug: "some-market",
    event_slug: "some-event",
    icon: "",
    outcome: "Yes",
    outcome_index: 0,
    transaction_hash: `0x${"11".repeat(32)}`,
    ...overrides,
  };
}

function v2PositionWire(overrides: Record<string, unknown> = {}) {
  return {
    proxy_wallet: WALLET,
    token_id: "x",
    condition_id: CONDITION,
    current_size: 10,
    avg_price: 0.4,
    entry_cost_usdc: 4,
    entry_fees_usdc: 0.02,
    total_cost_usdc: 4.02,
    total_size: 10,
    current_value: 8,
    unrealized_pnl: 4,
    total_pnl: 4,
    percent_pnl: 100,
    realized_pnl: 0,
    percent_realized_pnl: 0,
    current_price: 0.8,
    outcome: "Yes",
    outcome_index: 0,
    opposite_outcome: "No",
    opposite_token_id: "y",
    status: "OPEN",
    redeemable: false,
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
  } as unknown as Response;
}

describe("PolymarketDataApiClient.listTopTraders", () => {
  it("maps the saved /v2/leaderboard fixture onto domain entries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(LEADERBOARD_FIXTURE));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const entries = await client.listTopTraders();
    expect(entries).toHaveLength(LEADERBOARD_FIXTURE.data.length);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    const first = entries[0];
    const raw = LEADERBOARD_FIXTURE.data[0];
    if (!first || !raw) throw new Error("fixture is empty");
    expect(first).toMatchObject({
      rank: String(raw.rank),
      proxyWallet: raw.user_id,
      pnl: raw.pnl,
      vol: raw.volume,
    });
    expect(first.proxyWallet).toMatch(/^0x[a-f0-9]{40}$/);
  });

  it("hits /v2/leaderboard with time_period + sort_by + limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await client.listTopTraders({
      timePeriod: "DAY",
      orderBy: "VOL",
      limit: 10,
    });

    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/v2/leaderboard");
    expect(url.searchParams.get("time_period")).toBe("day");
    expect(url.searchParams.get("sort_by")).toBe("VOLUME");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("defaults to week / PNL / limit 10 when params omitted", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    await client.listTopTraders();
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("time_period")).toBe("week");
    expect(url.searchParams.get("sort_by")).toBe("PNL");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("throws a clear error on non-OK HTTP", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(null, false, 503));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listTopTraders()).rejects.toThrow(/503/);
  });

  it("throws on schema mismatch (fails closed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [{ rank: 1, wallet: "oops" }] }));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listTopTraders()).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
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

describe("PolymarketDataApiClient.listUserTrades", () => {
  const wallet = WALLET;

  it("hits /v2/trades?user=<wallet> with taker_only=false and maps rows to the domain trade", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(v2Page([v2Trade()])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const trades = await client.listUserTrades(wallet);
    expect(trades).toEqual([
      {
        proxyWallet: wallet,
        side: "BUY",
        asset: TOKEN,
        conditionId: CONDITION,
        size: 100,
        price: 0.75,
        timestamp: 1776353664,
        title: "Some market",
        slug: "some-market",
        eventSlug: "some-event",
        icon: "",
        outcome: "Yes",
        outcomeIndex: 0,
        transactionHash: `0x${"11".repeat(32)}`,
      },
    ]);
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/v2/trades");
    expect(url.searchParams.get("user")).toBe(wallet);
    expect(url.searchParams.get("taker_only")).toBe("false");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("lowercases condition_id at the adapter boundary", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        v2Page([v2Trade({ condition_id: `0x${"AB".repeat(32)}` })])
      )
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const [trade] = await client.listUserTrades(wallet);
    expect(trade?.conditionId).toBe(CONDITION);
  });

  it.each([
    ["token_id", undefined],
    ["condition_id", undefined],
    ["outcome_index", undefined],
    ["outcome", ""],
  ])("rejects a row whose %s is missing instead of defaulting it", async (field, value) => {
    const row = v2Trade({ [field]: value });
    if (value === undefined) delete (row as Record<string, unknown>)[field];
    const client = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(jsonResponse(v2Page([row]))),
    });
    await expect(client.listUserTrades(wallet)).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
  });

  it("filters by sinceTs and also sends it as the window start", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        v2Page([v2Trade({ timestamp: 1000 }), v2Trade({ timestamp: 3000 })])
      )
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const trades = await client.listUserTrades(wallet, { sinceTs: 2000 });
    expect(trades).toHaveLength(1);
    expect(trades[0]?.timestamp).toBe(3000);
    expect(
      new URL(fetchImpl.mock.calls[0]?.[0] as string).searchParams.get("start")
    ).toBe("2000");
  });

  it("excludes the boundary timestamp from sinceTs (strict >, not >=) — bug.0426", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        v2Page([v2Trade({ timestamp: 1000 }), v2Trade({ timestamp: 1001 })])
      )
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const trades = await client.listUserTrades(wallet, { sinceTs: 1000 });
    expect(trades).toHaveLength(1);
    expect(trades[0]?.timestamp).toBe(1001);
  });

  it("follows next_cursor up to maxPages, resending filters and dropping limit on cursor pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(v2Page([v2Trade({ timestamp: 30 })], "cursor-2"))
      )
      .mockResolvedValueOnce(
        jsonResponse(v2Page([v2Trade({ timestamp: 20 })], "cursor-3"))
      );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });

    const trades = await client.listUserTrades(wallet, {
      limit: 5,
      maxPages: 2,
      takerOnly: true,
    });

    expect(trades.map((t) => t.timestamp)).toEqual([30, 20]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = new URL(fetchImpl.mock.calls[1]?.[0] as string);
    expect(second.searchParams.get("cursor")).toBe("cursor-2");
    expect(second.searchParams.get("taker_only")).toBe("true");
    expect(second.searchParams.has("limit")).toBe(false);
  });

  it("stops as soon as the feed is exhausted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(v2Page([v2Trade()])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await client.listUserTrades(wallet, { maxPages: 10 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed wallet addresses", async () => {
    const fetchImpl = vi.fn();
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listUserTrades("not-a-wallet")).rejects.toThrow(
      /Invalid wallet/
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("PolymarketDataApiClient.listUserPositions (single cursor page)", () => {
  const wallet = WALLET;

  it("types the FIRST 429 like the shared cooldown without changing its HTTP message", async () => {
    __resetPolyDataApiCooldownForTests();
    const fetchImpl = vi.fn(
      async () =>
        new Response("busy", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "9" },
        })
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    try {
      await expect(client.listUserPositions(wallet)).rejects.toMatchObject({
        name: "PolyDataApiRateLimitedError",
        status: 429,
        retryable: false,
        retryAfterMs: 9000,
      });
      await expect(client.listUserPositions(wallet)).rejects.toBeInstanceOf(
        PolyDataApiRateLimitedError
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      __resetPolyDataApiCooldownForTests();
    }
  });

  it("wraps raw position Zod failures as semantic validation", async () => {
    const client = new PolymarketDataApiClient({
      fetch: vi.fn(async () =>
        jsonResponse(v2Page([{ current_size: "broken" }]))
      ),
    });
    await expect(client.listUserPositions(wallet)).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
  });

  it("rejects a row without outcome_index instead of defaulting it to 0", async () => {
    const row = v2PositionWire();
    delete (row as Record<string, unknown>).outcome_index;
    const client = new PolymarketDataApiClient({
      fetch: vi.fn(async () => jsonResponse(v2Page([row]))),
    });
    await expect(client.listUserPositions(wallet)).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
  });

  it("maps /v2/positions rows onto the domain position and reports the next cursor", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(v2Page([v2PositionWire()], "more")));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const page = await client.listUserPositions(wallet);
    expect(page.nextCursor).toBe("more");
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      proxyWallet: wallet,
      asset: "x",
      conditionId: CONDITION,
      size: 10,
      avgPrice: 0.4,
      initialValue: 4,
      grossInitialValue: 4.02,
      entryFeesUsdc: 0.02,
      currentValue: 8,
      cashPnl: 4,
      outcomeIndex: 0,
      oppositeAsset: "y",
    });
  });

  it("keeps a missing opposite token null, never an empty string", async () => {
    const client = new PolymarketDataApiClient({
      fetch: vi.fn(async () =>
        jsonResponse(v2Page([v2PositionWire({ opposite_token_id: null })]))
      ),
    });
    const page = await client.listUserPositions(wallet);
    expect(page.rows[0]?.oppositeAsset).toBeNull();
  });

  it("sends v2 params, never offset, and drops limit on cursor pages", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(v2Page([])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await client.listUserPositions(wallet, {
      market: CONDITION.toUpperCase().replace("0X", "0x"),
      sizeThreshold: 100,
      limit: 25,
    });
    await client.listUserPositions(wallet, {
      sizeThreshold: 100,
      limit: 25,
      cursor: "cursor-2",
    });
    const first = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(first.pathname).toBe("/v2/positions");
    expect(first.searchParams.get("user")).toBe(wallet);
    expect(first.searchParams.get("condition")).toBe(CONDITION);
    expect(first.searchParams.get("filter_type")).toBe("TOKENS");
    expect(first.searchParams.get("filter_amount")).toBe("100");
    expect(first.searchParams.get("limit")).toBe("25");
    expect(first.searchParams.has("offset")).toBe(false);
    const second = new URL(fetchImpl.mock.calls[1]?.[0] as string);
    expect(second.searchParams.get("cursor")).toBe("cursor-2");
    expect(second.searchParams.get("filter_amount")).toBe("100");
    expect(second.searchParams.has("limit")).toBe(false);
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

  it("allows CLOSED only by explicit recovery opt-in and preserves OPEN defaults", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page([makePosition(condition(1), "11", { status: "CLOSED", current_size: 0, current_value: 0 })])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const history = await client.listUserPositionsV2Raw(wallet, { conditions: [condition(1)], status: "CLOSED", maxRequests: 2 });
    expect(history.positions[0]?.status).toBe("CLOSED");
    const closedUrl = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(closedUrl.searchParams.get("status")).toBe("CLOSED");
    expect(closedUrl.searchParams.get("include_archived")).toBe("false");
    await expect(client.listUserPositionsV2Raw(wallet, { conditions: [condition(1)] })).rejects.toThrow(/outside the requested OPEN/);
    expect(new URL(fetchImpl.mock.calls[1]?.[0] as string).searchParams.get("include_archived")).toBe("true");
  });

  it("rejects CLOSED with archived inclusion before issuing a request", async () => {
    const fetchImpl = vi.fn();
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listUserPositionsV2Raw(wallet, {
      conditions: [condition(1)],
      status: "CLOSED",
      includeArchived: true,
    })).rejects.toMatchObject({
      code: "INVALID_V2_POSITIONS_WALK",
      reason: "malformed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
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

    const positions = await client.listAllUserPositions(wallet);

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
  const wallet = WALLET;
  const activityRow = (overrides: Record<string, unknown> = {}) => ({
    proxy_wallet: wallet,
    timestamp: 1776000000,
    condition_id: CONDITION,
    type: "TRADE",
    token_id: TOKEN,
    transaction_hash: `0x${"22".repeat(32)}`,
    size: 10,
    usdc_size: 5,
    price: 0.5,
    side: "BUY",
    title: "Some market",
    event_slug: "some-event",
    ...overrides,
  });

  it("hits /v2/activity with type/side/start/end/limit and maps the page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(v2Page([activityRow()], "next")));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const page = await client.listActivity(wallet, {
      type: "TRADE",
      side: "BUY",
      start: 1770000000,
      end: 1780000000,
      limit: 50,
    });
    expect(page.nextCursor).toBe("next");
    expect(page.rows).toEqual([
      {
        proxyWallet: wallet,
        type: "TRADE",
        timestamp: 1776000000,
        conditionId: CONDITION,
        asset: TOKEN,
        side: "BUY",
        size: 10,
        usdcSize: 5,
        price: 0.5,
        outcome: null,
        title: "Some market",
        slug: null,
        eventSlug: "some-event",
        transactionHash: `0x${"22".repeat(32)}`,
      },
    ]);
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/v2/activity");
    expect(url.searchParams.get("user")).toBe(wallet);
    expect(url.searchParams.get("type")).toBe("TRADE");
    expect(url.searchParams.get("side")).toBe("BUY");
    expect(url.searchParams.get("start")).toBe("1770000000");
    expect(url.searchParams.get("end")).toBe("1780000000");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("maps a lifecycle row with no token / side / price to nulls", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        v2Page([
          activityRow({
            type: "REDEEM",
            token_id: null,
            side: "",
            price: null,
          }),
        ])
      )
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const page = await client.listActivity(wallet);
    expect(page.rows[0]).toMatchObject({
      type: "REDEEM",
      asset: null,
      side: null,
      price: null,
    });
  });

  it("rejects a TRADE row without an exact token id", async () => {
    const client = new PolymarketDataApiClient({
      fetch: vi
        .fn()
        .mockResolvedValue(jsonResponse(v2Page([activityRow({ token_id: null })]))),
    });
    await expect(client.listActivity(wallet)).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
  });

  it("throws on schema mismatch (fails closed)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(v2Page([{ totally: "wrong" }])));
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
  const wallet = WALLET;

  it("returns `{ user, value }` from /v2/value and scopes by condition", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ data: { proxy_wallet: wallet, value: 123.45 } })
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const result = await client.getValue(wallet, { market: CONDITION });
    expect(result.user).toBe(wallet);
    expect(result.value).toBeCloseTo(123.45);
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/v2/value");
    expect(url.searchParams.get("user")).toBe(wallet);
    expect(url.searchParams.get("condition")).toBe(CONDITION);
  });

  it("returns zero for the documented miss (data: null)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: null }));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const result = await client.getValue(wallet);
    expect(result).toEqual({ user: wallet, value: 0 });
  });

  it("rejects a non-hex market before any request", async () => {
    const fetchImpl = vi.fn();
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(
      client.getValue(wallet, { market: "0xabc" })
    ).rejects.toThrow(/Invalid condition id/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("PolymarketDataApiClient.getHolders", () => {
  const holder = (overrides: Record<string, unknown> = {}) => ({
    proxy_wallet: "0xaaa",
    token_id: TOKEN,
    outcome_index: 0,
    amount: 500,
    name: "alice",
    pseudonym: "Quiet-Fox",
    display_username_public: true,
    ...overrides,
  });

  it("hits /v2/holders?condition=<id>&limit and flattens token groups", async () => {
    const body = {
      data: [
        { token_id: TOKEN, holders: [holder()] },
        {
          token_id: "999",
          holders: [holder({ token_id: "999", outcome_index: 1, amount: 7 })],
        },
      ],
    };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(body));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const holders = await client.getHolders(CONDITION, { limit: 10 });
    expect(holders).toEqual([
      {
        proxyWallet: "0xaaa",
        asset: TOKEN,
        outcomeIndex: 0,
        amount: 500,
        name: "alice",
        pseudonym: "Quiet-Fox",
        displayUsernamePublic: true,
      },
      {
        proxyWallet: "0xaaa",
        asset: "999",
        outcomeIndex: 1,
        amount: 7,
        name: "alice",
        pseudonym: "Quiet-Fox",
        displayUsernamePublic: true,
      },
    ]);
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/v2/holders");
    expect(url.searchParams.get("condition")).toBe(CONDITION);
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("rejects a holder whose token_id differs from its group", async () => {
    const client = new PolymarketDataApiClient({
      fetch: vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ token_id: TOKEN, holders: [holder({ token_id: "999" })] }],
        })
      ),
    });
    await expect(client.getHolders(CONDITION)).rejects.toBeInstanceOf(
      PolyDataApiValidationError
    );
  });

  it("throws on empty market", async () => {
    const client = new PolymarketDataApiClient({ fetch: vi.fn() });
    await expect(client.getHolders("")).rejects.toThrow(/condition/);
  });
});

describe("PolymarketDataApiClient.listMarketTrades", () => {
  it("hits /v2/trades?condition=<id> (no user), defaults taker_only=true, and returns a page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        v2Page([v2Trade({ proxy_wallet: "0xtaker" })], "next")
      )
    );
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    const page = await client.listMarketTrades(CONDITION, { limit: 50 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]?.proxyWallet).toBe("0xtaker");
    expect(page.nextCursor).toBe("next");
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe("/v2/trades");
    expect(url.searchParams.get("condition")).toBe(CONDITION);
    expect(url.searchParams.get("taker_only")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.has("user")).toBe(false);
  });

  it("includes maker rows when takerOnly is explicitly false", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(v2Page([])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await client.listMarketTrades(CONDITION, { takerOnly: false });
    expect(
      new URL(fetchImpl.mock.calls[0]?.[0] as string).searchParams.get(
        "taker_only"
      )
    ).toBe("false");
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
    // Missing required `proxy_wallet` on the event — should fail the envelope parse.
    const malformed = v2Page([{ type: "TRADE", timestamp: 1700000000 }]);
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
      expect(typed.endpoint).toBe("/v2/activity");
      expect(typed.issues.length).toBeGreaterThan(0);
    }
  });

  it("throws PolyDataApiValidationError when /v2/holders returns no data envelope", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "not an array" }));
    const client = new PolymarketDataApiClient({
      fetch: fetchImpl,
      baseUrl: "http://fake.test",
    });
    await expect(
      client.getHolders(CONDITION, { limit: 10 })
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
      json: async () => v2Page([]),
    })) as unknown as typeof fetch;

    const a = new PolymarketDataApiClient({ fetch: firstFetch });
    await expect(a.listUserTrades("0x2005d16a84ceefa912d4e380cd32e7ff827875ea")).rejects.toThrow(/429/);

    const b = new PolymarketDataApiClient({ fetch: secondFetch });
    await expect(b.listUserTrades("0x2005d16a84ceefa912d4e380cd32e7ff827875ea")).rejects.toThrow(
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
        json: async () => v2Page([]),
      };
    }) as unknown as typeof fetch;

    // Six requests spread over three DIFFERENT client instances — the real
    // shape, since the app constructs one client per consumer.
    const clients = [0, 1, 2].map(
      () => new PolymarketDataApiClient({ fetch: fetchImpl })
    );
    const wallets = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
    const calls = clients.flatMap((c) => [
      c.listUserTrades(wallets),
      c.listUserTrades(wallets),
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
        json: async () => v2Page([]),
      };
    }) as unknown as typeof fetch;

    const c = new PolymarketDataApiClient({ fetch: fetchImpl });
    const w = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
    // Saturate the cap, then queue one more behind it with its own signal.
    const inflight = [c.listUserTrades(w), c.listUserTrades(w)];
    const controller = new AbortController();
    const queued = c.listUserTrades(w, { signal: controller.signal });

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
      c.listUserTrades(w, { signal: saturating.signal }),
      c.listUserTrades(w, { signal: saturating.signal }),
    ];
    const queued = c.listUserTrades(w, { signal: controller.signal });
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
    await expect(c.listUserTrades(w)).rejects.toThrow(/429/);
    await expect(c.listUserTrades(w)).rejects.toThrow(
      PolyDataApiRateLimitedError
    );
    expect(__polyDataApiInflightForTests()).toEqual({ inFlight: 0, queued: 0 });
  });
});


describe("bounded native activity recovery", () => {
  beforeEach(() => __resetPolyDataApiCooldownForTests());
  const wallet = `0x${"ac".repeat(20)}`;
  const conditionId = `0x${"bd".repeat(32)}`;
  const row = { proxy_wallet: wallet, condition_id: conditionId, timestamp: 100,
    type: "TRADE", token_id: "1", transaction_hash: `0x${"aa".repeat(32)}`,
    size: 10, usdc_size: 4.123456, price: 0.4123, side: "BUY" };
  const page = (data: unknown[], cursor: string | null = null) => ({ data, pagination: { has_more: cursor !== null, limit: 1000, offset: 0, next_cursor: cursor } });
  it("retains native USDC and rejects repeated pages without extra requests", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(page([row], "next")))
      .mockResolvedValueOnce(jsonResponse(page([row])));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listConditionActivityV2(wallet, { conditionId, start: 0, end: 200, maxRequests: 2 })).rejects.toThrow(/overlapping activity pages/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const single = new PolymarketDataApiClient({ fetch: vi.fn().mockResolvedValue(jsonResponse(page([row, { ...row, type: "REDEEM", side: "", token_id: "" }]))) });
    expect((await single.listConditionActivityV2(wallet, { conditionId, start: 0, end: 200, maxRequests: 2 })).activity[0]?.usdc_size).toBe(4.123456);
  });
  it("withholds incomplete cursors and rejects wrong-condition data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(page([row], "more")));
    const client = new PolymarketDataApiClient({ fetch: fetchImpl });
    await expect(client.listConditionActivityV2(wallet, { conditionId, start: 0, end: 200, maxRequests: 1 })).rejects.toThrow(/request budget exhausted/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const foreign = new PolymarketDataApiClient({ fetch: vi.fn().mockResolvedValue(jsonResponse(page([{ ...row, condition_id: `0x${"ee".repeat(32)}` }]))) });
    await expect(foreign.listConditionActivityV2(wallet, { conditionId, start: 0, end: 200, maxRequests: 2 })).rejects.toThrow(/outside requested/);
  });
});
