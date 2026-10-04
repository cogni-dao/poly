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
});

describe("omitted-position exact balance authority", () => {
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
