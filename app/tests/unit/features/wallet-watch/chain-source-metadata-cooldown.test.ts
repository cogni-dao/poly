// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/tests/unit/features/wallet-watch/chain-source-metadata-cooldown`
 * Purpose: Pin CACHE_MISS_REFRESH_IS_RATE_LIMITED (bug.5276) — a burst of fills on
 *          permanently-unresolvable tokenIds must collapse to ONE `/positions` walk.
 * Scope: Drives `createPolymarketChainActivitySource` with a fake Data-API client and a
 *        stub viem PublicClient. No network, no chain.
 * Invariants: `cold_start` still refreshes; `cache_miss` inside the cooldown does not.
 * Side-effects: none
 * Links: app/src/features/wallet-watch/polymarket-chain-source.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import type { PolymarketDataApiClient } from "@cogni/poly-market-provider";
import { createPolymarketChainActivitySource } from "@/features/wallet-watch/polymarket-chain-source";

const WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;

function makeLogger() {
  const l = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
  };
  return l;
}

/** Stub viem client — the source only needs watchEvent/getBlock to exist. */
function makePublicClient() {
  return {
    watchContractEvent: vi.fn(() => () => undefined),
    watchEvent: vi.fn(() => () => undefined),
    getBlock: vi.fn(async () => ({ timestamp: 1_790_000_000n })),
  } as never;
}

describe("polymarket chain source — cache-miss refresh cooldown (bug.5276)", () => {
  it("walks /positions once on cold start, not once per unresolvable fill", async () => {
    // The wallet holds NO positions, so every tokenId is permanently
    // unresolvable — the exact prod shape that produced
    // `429 Too Many Requests (/positions)`: 29 distinct tokenIds driving 180
    // metadata_unresolved events, each previously re-walking the full API.
    const listAllUserPositions = vi.fn(async () => []);
    const client = {
      listAllUserPositions,
      listUserPositions: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;

    const source = createPolymarketChainActivitySource({
      publicClient: makePublicClient(),
      client,
      wallet: WALLET,
      logger: makeLogger() as never,
      metrics: { incr: vi.fn(), observeDurationMs: vi.fn() } as never,
      heartbeatIntervalMs: 0,
    });

    // Let the fire-and-forget cold_start refresh settle.
    await vi.waitFor(() => expect(listAllUserPositions).toHaveBeenCalled());
    const afterColdStart = listAllUserPositions.mock.calls.length;
    expect(afterColdStart).toBe(1);

    // Any further cache-miss-driven refresh inside the 60s cooldown must be
    // suppressed. Before this fix each miss re-walked the paginated API.
    await new Promise((r) => setTimeout(r, 20));
    expect(listAllUserPositions.mock.calls.length).toBe(afterColdStart);

    source.stop();
  });
});
