// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/tests/unit/features/wallet-watch/chain-source-gamma-fallback`
 * Purpose: Prove a first target fill survives lagging/rate-limited position metadata.
 * Scope: Fake chain subscription + metadata clients; no network or database.
 * Invariants: ORIGINAL_FILL_IS_PRESERVED, AMBIGUOUS_METADATA_FAILS_CLOSED.
 * Side-effects: none
 * Links: bug.5012, story.5015
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import type { PolymarketDataApiClient } from "@cogni/poly-market-provider/adapters/polymarket";
import { projectPositionGapCohorts } from "@/features/copy-trade/position-gap-cohorts";
import { createPolymarketChainActivitySource } from "@/features/wallet-watch/polymarket-chain-source";

const WALLET = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea" as const;
const TOKEN_ID = "686203923426123";
const CONDITION_ID = `0x${"ab".repeat(32)}`;

function makeLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function makePublicClient() {
  const subscriptions: Array<{ onLogs: (logs: unknown[]) => void }> = [];
  return {
    subscriptions,
    client: {
      watchContractEvent: vi.fn((config: { onLogs: (logs: unknown[]) => void }) => {
        subscriptions.push(config);
        return () => undefined;
      }),
      getBlock: vi.fn(async () => ({ timestamp: 1_790_000_000n })),
    } as never,
  };
}

function orderFilledLog(logIndex = 7, maker = WALLET) {
  return {
    removed: false,
    transactionHash: `0x${"12".repeat(32)}`,
    logIndex,
    blockNumber: 100n,
    args: {
      maker,
      side: 0,
      tokenId: BigInt(TOKEN_ID),
      makerAmountFilled: 2_000_000n,
      takerAmountFilled: 5_000_000n,
    },
  };
}

describe("polymarket chain source — exact-token Gamma fallback", () => {
  it("does not await a stalled positions walk, preserves the fill, and creates its forward cohort", async () => {
    const listAllUserPositions = vi.fn(
      () => new Promise<never>(() => undefined)
    );
    const resolveTokenMetadata = vi.fn(async () => ({
      conditionId: CONDITION_ID,
      outcome: "Player A",
      endDate: "2026-10-09T00:00:00Z",
      title: "Player A vs Player B",
      slug: "player-a-v-player-b",
    }));
    const chain = makePublicClient();
    const source = createPolymarketChainActivitySource({
      publicClient: chain.client,
      client: {
        listAllUserPositions,
        resolveTokenMetadata,
      } as unknown as PolymarketDataApiClient,
      wallet: WALLET,
      logger: makeLogger() as never,
      metrics: { incr: vi.fn(), observeDurationMs: vi.fn() } as never,
      heartbeatIntervalMs: 0,
    });
    await vi.waitFor(() => expect(listAllUserPositions).toHaveBeenCalled());

    const woke = new Promise<void>((resolve) => source.subscribeWake(resolve));
    chain.subscriptions[0]?.onLogs([orderFilledLog()]);
    await woke;
    const result = await source.fetchSince();
    const fill = result.fills[0];

    expect(fill).toMatchObject({
      fill_id: `chain:0x${"12".repeat(32)}:7:BUY`,
      source: "chain",
      market_id: `prediction-market:polymarket:${CONDITION_ID}`,
      outcome: "Player A",
      side: "BUY",
      price: 0.4,
      size_usdc: 2,
      attributes: {
        asset: TOKEN_ID,
        condition_id: CONDITION_ID,
        transaction_hash: `0x${"12".repeat(32)}`,
      },
    });
    expect(resolveTokenMetadata).toHaveBeenCalledTimes(1);

    const projection = projectPositionGapCohorts({
      existing: [],
      netTargetPositions: [
        {
          conditionId: CONDITION_ID,
          tokenId: TOKEN_ID,
          marketId: fill?.market_id ?? "",
          outcome: fill?.outcome ?? "",
          netShares: 20,
          activationPriceCap: 0.4,
        },
      ],
      activity: [
        {
          fillId: fill?.fill_id ?? "",
          side: fill?.side ?? "SELL",
          conditionId: CONDITION_ID,
          tokenId: TOKEN_ID,
          marketId: fill?.market_id ?? "",
          outcome: fill?.outcome ?? "",
          shares:
            fill && fill.price > 0 ? fill.size_usdc / fill.price : 0,
          price: fill?.price ?? 0,
          observedAtMs: Date.parse(fill?.observed_at ?? ""),
        },
      ],
      snapshotId: "snapshot-1",
      snapshotHash: "hash-1",
      configRevision: "revision-1",
      previousBudgetUsdc: 20,
      budgetUsdc: 20,
      allocationDenominatorUsdc: 200,
      scale: 0.1,
      activation: false,
      nowMs: 1_790_000_000_000,
    });
    expect(projection.creations).toEqual([
      expect.objectContaining({
        sourceKind: "target_buy",
        sourceEventId: fill?.fill_id,
        tokenId: TOKEN_ID,
        benchmarkTargetVwap: 0.4,
        targetDeltaShares: 5,
        allowedMirrorShares: 0.5,
      }),
    ]);
    source.stop();
  });

  it("coalesces concurrent exact lookups for the same target token", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolveTokenMetadata = vi.fn(async () => {
      await gate;
      return {
        conditionId: CONDITION_ID,
        outcome: "Player A",
        endDate: null,
        title: null,
        slug: null,
      };
    });
    const chain = makePublicClient();
    const secondWallet =
      "0x3005d16a84ceefa912d4e380cd32e7ff827875ea" as const;
    const source = createPolymarketChainActivitySource({
      publicClient: chain.client,
      client: {
        listAllUserPositions: vi.fn(async () => []),
        resolveTokenMetadata,
      } as unknown as PolymarketDataApiClient,
      wallet: secondWallet,
      logger: makeLogger() as never,
      metrics: { incr: vi.fn(), observeDurationMs: vi.fn() } as never,
      heartbeatIntervalMs: 0,
    });
    await vi.waitFor(() => expect(chain.subscriptions).toHaveLength(2));

    let wakes = 0;
    const bothWoke = new Promise<void>((resolve) => {
      source.subscribeWake(() => {
        wakes += 1;
        if (wakes === 2) resolve();
      });
    });
    chain.subscriptions[0]?.onLogs([
      orderFilledLog(8, secondWallet),
      orderFilledLog(9, secondWallet),
    ]);
    await vi.waitFor(() => expect(resolveTokenMetadata).toHaveBeenCalledTimes(1));
    release();
    await bothWoke;
    expect((await source.fetchSince()).fills).toHaveLength(2);
    source.stop();
  });

  it("fails closed when invalid or ambiguous exact-token metadata resolves to null", async () => {
    const thirdWallet =
      "0x4005d16a84ceefa912d4e380cd32e7ff827875ea" as const;
    const logger = makeLogger();
    const resolveTokenMetadata = vi.fn(async () => null);
    const chain = makePublicClient();
    const source = createPolymarketChainActivitySource({
      publicClient: chain.client,
      client: {
        listAllUserPositions: vi.fn(async () => []),
        resolveTokenMetadata,
      } as unknown as PolymarketDataApiClient,
      wallet: thirdWallet,
      logger: logger as never,
      metrics: { incr: vi.fn(), observeDurationMs: vi.fn() } as never,
      heartbeatIntervalMs: 0,
    });

    chain.subscriptions[0]?.onLogs([orderFilledLog(10, thirdWallet)]);
    await vi.waitFor(() => {
      expect(resolveTokenMetadata).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ phase: "metadata_unresolved" }),
        expect.stringContaining("metadata unresolved")
      );
    });
    expect((await source.fetchSince()).fills).toEqual([]);
    source.stop();
  });
});
