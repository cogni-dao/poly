// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/position-balance-authority`
 * Purpose: Pin the exact-bigint terminal gate for omitted current positions.
 * Scope: Pure policy; no DB or Polygon IO.
 * Invariants:
 *   - ZERO_ONLY_DEACTIVATES: only a complete vector of exact `0n` balances
 *     permits publication; every nonzero value, including one atomic unit of
 *     dust, blocks publication.
 * Side-effects: none
 * Links: work item subtask.5000
 * @public
 */

import type { PolymarketDataApiClient } from "@cogni/poly-market-provider/adapters/polymarket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPolygonPositionBalanceBatchReader } from "@/features/wallet-analysis/server/position-balance-authority";
import {
  classifyMissingPositionsWithBalances,
  classifyMissingPositionBalances,
  fetchTraderPositionsPages,
  type MissingCurrentPosition,
} from "@/features/wallet-analysis/server/trader-observation-service";

function missing(index: number): MissingCurrentPosition {
  return {
    conditionId: `condition-${index}`,
    tokenId: String(index + 1),
    shares: 1,
    currentValueUsdc: 1,
    lastObservedAt: new Date(0),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("omitted-position exact balance authority", () => {
  it("sends exactly one wire request on RPC failure instead of hidden transport retries", async () => {
    const fetch = vi.fn(
      async () => new Response("upstream unavailable", { status: 503 })
    );
    vi.stubGlobal("fetch", fetch);
    const read = createPolygonPositionBalanceBatchReader({
      rpcUrl: "https://polygon.invalid",
    });

    await expect(
      read({
        walletAddress: `0x${"a".repeat(40)}`,
        tokenIds: ["1", "2"],
        signal: new AbortController().signal,
      })
    ).rejects.toThrow();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts only a complete exact-zero bigint vector", () => {
    expect(classifyMissingPositionBalances([0n, 0n], 2)).toBe("all_zero");
  });

  it("treats one atomic unit of dust as nonzero and blocks publication", () => {
    expect(classifyMissingPositionBalances([0n, 1n], 2)).toBe(
      "authority_nonzero"
    );
  });

  it.each([
    { balances: [0n], expected: 2 },
    { balances: [0n, "0"], expected: 2 },
    { balances: [0n, -1n], expected: 2 },
  ])("rejects malformed authority vector %#", ({ balances, expected }) => {
    expect(classifyMissingPositionBalances(balances, expected)).toBe(
      "authority_malformed"
    );
  });

  it("marks a full tenth 500-row Data API page incomplete at 5,000 rows", async () => {
    const listUserPositions = vi.fn(async () =>
      Array.from({ length: 500 }, (_value, index) => ({
        conditionId: `condition-${index}`,
        asset: String(index),
      }))
    );
    const result = await fetchTraderPositionsPages({
      client: { listUserPositions } as unknown as PolymarketDataApiClient,
      walletAddress: `0x${"a".repeat(40)}`,
      maxPages: 99,
    });
    expect(listUserPositions).toHaveBeenCalledTimes(10);
    expect(result).toMatchObject({ complete: false, pages: 10 });
    expect(result.positions).toHaveLength(5_000);
  });

  it("runs at most 50 sequential chunks of at most 100 token ids", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sizes: number[] = [];
    const result = await classifyMissingPositionsWithBalances({
      walletAddress: `0x${"b".repeat(40)}`,
      positions: Array.from({ length: 5_000 }, (_value, index) =>
        missing(index)
      ),
      readPositionBalances: async ({ tokenIds }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        sizes.push(tokenIds.length);
        await Promise.resolve();
        inFlight -= 1;
        return tokenIds.map(() => 0n);
      },
    });
    expect(result).toMatchObject({
      reason: "all_zero",
      classifiedCount: 5_000,
      zeroCount: 5_000,
      chunkCount: 50,
    });
    expect(maxInFlight).toBe(1);
    expect(sizes).toHaveLength(50);
    expect(Math.max(...sizes)).toBe(100);
  });

  it("shares the thirty-second deadline and fifty-chunk ceiling across cohorts and retries", async () => {
    const budget = { startedAt: Date.now(), chunkCount: 49 };
    const read = vi.fn(async ({ tokenIds }: { tokenIds: readonly string[] }) =>
      tokenIds.map(() => 0n)
    );
    const input = {
      walletAddress: `0x${"b".repeat(40)}`,
      budget,
      readPositionBalances: read,
    };
    expect(
      await classifyMissingPositionsWithBalances({
        ...input,
        positions: [missing(1)],
      })
    ).toMatchObject({ reason: "all_zero", chunkCount: 1 });
    expect(
      await classifyMissingPositionsWithBalances({
        ...input,
        positions: [missing(2)],
      })
    ).toMatchObject({ reason: "authority_unavailable", chunkCount: 0 });
    expect(read).toHaveBeenCalledTimes(1);
    budget.chunkCount = 0;
    budget.startedAt = Date.now() - 30_001;
    expect(
      await classifyMissingPositionsWithBalances({
        ...input,
        positions: [missing(3)],
      })
    ).toMatchObject({ reason: "authority_unavailable", chunkCount: 0 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects a result-length mismatch without inventing decisions", async () => {
    const result = await classifyMissingPositionsWithBalances({
      walletAddress: `0x${"c".repeat(40)}`,
      positions: [missing(1), missing(2)],
      readPositionBalances: async () => [0n],
    });
    expect(result).toMatchObject({
      reason: "authority_malformed",
      classifiedCount: 0,
      zeroCount: 0,
      nonzeroCount: 0,
      chunkCount: 1,
    });
  });

  it("aborts the underlying chunk and returns unavailable at five seconds", async () => {
    vi.useFakeTimers();
    let chunkSignal: AbortSignal | undefined;
    const pending = classifyMissingPositionsWithBalances({
      walletAddress: `0x${"d".repeat(40)}`,
      positions: [missing(1)],
      readPositionBalances: async ({ signal }) => {
        chunkSignal = signal;
        return await new Promise<readonly bigint[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(pending).resolves.toMatchObject({
      reason: "authority_unavailable",
      chunkCount: 1,
    });
    expect(chunkSignal?.aborted).toBe(true);
  });

  it("bounds the whole sequential authority walk to thirty seconds", async () => {
    vi.useFakeTimers();
    const pending = classifyMissingPositionsWithBalances({
      walletAddress: `0x${"e".repeat(40)}`,
      positions: Array.from({ length: 700 }, (_value, index) => missing(index)),
      readPositionBalances: async ({ tokenIds, signal }) =>
        await new Promise<readonly bigint[]>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(tokenIds.map(() => 0n)),
            4_999
          );
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true }
          );
        }),
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(pending).resolves.toMatchObject({
      reason: "authority_unavailable",
      classifiedCount: 600,
      chunkCount: 7,
    });
  });
});

describe("bounded prompt position recovery", () => {
  it("retries only the failed page once and enumerates newly redeemable claims unfiltered", async () => {
    const { PolymarketDataApiClient } = await import(
      "@cogni/poly-market-provider/adapters/polymarket"
    );
    const { PositionObservationBudget, PositionObservationController } =
      await import(
        "@/features/wallet-analysis/server/position-observation-control"
      );
    const wait = vi.fn(async () => {});
    const budget = new PositionObservationBudget(
      new PositionObservationController({ random: () => 0.5, wait })
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              proxyWallet: `0x${"a".repeat(40)}`,
              asset: "1",
              conditionId: "c",
              size: 21.14,
              avgPrice: 0.4,
              initialValue: 8,
              currentValue: 0,
              cashPnl: -8,
              percentPnl: -100,
              realizedPnl: 0,
              curPrice: 0,
              redeemable: true,
            },
          ]),
          { status: 200 }
        )
      );
    const result = await fetchTraderPositionsPages({
      client: new PolymarketDataApiClient({ fetch }),
      walletAddress: `0x${"a".repeat(40)}`,
      maxPages: 10,
      budget,
    });
    expect(result).toMatchObject({
      complete: true,
      pages: 1,
      positions: [{ size: 21.14, redeemable: true }],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(1000, undefined);
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls.map((url) => url.searchParams.get("offset"))).toEqual([
      "0",
      "0",
    ]);
    expect(urls.every((url) => !url.searchParams.has("redeemable"))).toBe(true);
    expect(budget.dataApiCalls).toBe(2);
  });

  it("stops blocking omissions at first nonzero chunk but continues the terminal cohort", async () => {
    const read = vi.fn(async ({ tokenIds }: { tokenIds: readonly string[] }) =>
      tokenIds.map((_, i) => (i === 0 ? 1n : 0n))
    );
    const input = {
      walletAddress: `0x${"b".repeat(40)}`,
      positions: Array.from({ length: 250 }, (_, i) => missing(i)),
      readPositionBalances: read,
    };
    expect(
      await classifyMissingPositionsWithBalances({
        ...input,
        stopOnNonzero: true,
      })
    ).toMatchObject({
      reason: "authority_nonzero",
      chunkCount: 1,
      classifiedCount: 100,
    });
    read.mockClear();
    expect(await classifyMissingPositionsWithBalances(input)).toMatchObject({
      chunkCount: 3,
      classifiedCount: 250,
    });
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("cannot turn the fiftieth failed authority call into a fifty-first retry", async () => {
    const {
      PositionObservationBudget,
      PositionObservationController,
      PositionBalanceTransportError,
    } = await import(
      "@/features/wallet-analysis/server/position-observation-control"
    );
    const budget = new PositionObservationBudget(
      new PositionObservationController({ wait: vi.fn(async () => {}) })
    );
    budget.chunkCount = 49;
    const read = vi.fn(async () => {
      throw new PositionBalanceTransportError("503");
    });
    const result = await classifyMissingPositionsWithBalances({
      walletAddress: "w",
      positions: [missing(1)],
      readPositionBalances: read,
      budget,
    });
    expect(result.reason).toBe("authority_unavailable");
    expect(read).toHaveBeenCalledTimes(1);
    expect(budget.chunkCount).toBe(50);
  });

  it("does not retry across the remaining authority deadline", async () => {
    const {
      PositionObservationBudget,
      PositionObservationController,
      PositionBalanceTransportError,
    } = await import(
      "@/features/wallet-analysis/server/position-observation-control"
    );
    let now = 25_000;
    const wait = vi.fn(async (ms: number) => {
      now += ms;
    });
    const budget = new PositionObservationBudget(
      new PositionObservationController({
        now: () => now,
        random: () => 0.5,
        wait,
      })
    );
    budget.startedAt = 1_000; // 24 seconds already spent by the other cohort.
    const read = vi.fn(async () => {
      now += 5_000;
      throw new PositionBalanceTransportError("timeout");
    });
    await classifyMissingPositionsWithBalances({
      walletAddress: "w",
      positions: [missing(1)],
      readPositionBalances: read,
      budget,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(budget.budgetExhausted).toBe("authority");
  });
});

describe("transport timeout recovery and settlement", () => {
  it("waits for the timed-out HTTP call to settle, then gives its one retry a fresh five-second signal", async () => {
    vi.useFakeTimers();
    const { PolymarketDataApiClient } = await import(
      "@cogni/poly-market-provider/adapters/polymarket"
    );
    const { PositionObservationBudget, PositionObservationController } =
      await import(
        "@/features/wallet-analysis/server/position-observation-control"
      );
    const signals: AbortSignal[] = [];
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        signals.push(signal);
        if (signals.length === 1)
          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => setTimeout(() => reject(signal.reason), 200),
              { once: true }
            );
          });
        expect(signal.aborted).toBe(false);
        return new Response("[]", { status: 200 });
      }
    );
    const budget = new PositionObservationBudget(
      new PositionObservationController({ random: () => 0.5 })
    );
    const pending = fetchTraderPositionsPages({
      client: new PolymarketDataApiClient({ fetch }),
      walletAddress: `0x${"a".repeat(40)}`,
      maxPages: 10,
      budget,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(signals[0]?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1199);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ complete: true, pages: 1 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signals[1]).not.toBe(signals[0]);
  });
});

describe("CTF wire cancellation", () => {
  it("forwards its deadline to actual HTTP and waits for delayed transport settlement", async () => {
    vi.useFakeTimers();
    let wireSignal: AbortSignal | undefined;
    let settled = false;
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        wireSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) =>
          wireSignal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                settled = true;
                reject(wireSignal?.reason);
              }, 200);
            },
            { once: true }
          )
        );
      }
    );
    vi.stubGlobal("fetch", fetch);
    const read = createPolygonPositionBalanceBatchReader({
      rpcUrl: "https://polygon.invalid",
    });
    const pending = read({
      walletAddress: `0x${"a".repeat(40)}`,
      tokenIds: ["1"],
      signal: new AbortController().signal,
    });
    const assertion = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    expect(wireSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(settled).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
