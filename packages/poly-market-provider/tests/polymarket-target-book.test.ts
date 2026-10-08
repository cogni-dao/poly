// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Fail-closed contract tests for the bounded immutable target-book cache. */
import { describe, expect, it, vi } from "vitest";

import {
  createPolymarketTargetBookProviderV1,
  type PolymarketTargetBookDataSourceV1,
} from "../src/adapters/polymarket/index.js";
import type { PolymarketUserPositionV2 } from "../src/adapters/polymarket/polymarket.data-api-v2.types.js";
import type { PolymarketDataApiStatusV2 } from "../src/adapters/polymarket/polymarket.data-api-v2.types.js";

const WALLET = "0x9f2fe025f84839ca81dd8e0338892605702d2ca8";
const condition = (suffix: number) =>
  `0x${suffix.toString(16).padStart(64, "0")}`;

function healthyStatus(
  overrides: Partial<PolymarketDataApiStatusV2> = {}
): PolymarketDataApiStatusV2 {
  return {
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
      ],
    },
    ingestion: {
      cursors: 175,
      network: "polygon",
      chain_id: 137,
      max_synced_block: 95_148_145,
    },
    ...overrides,
  };
}

function row(
  conditionId: string,
  tokenId: string,
  oppositeTokenId: string,
  overrides: Partial<PolymarketUserPositionV2> = {}
): PolymarketUserPositionV2 {
  return {
    avg_price: 0.4,
    condition_id: conditionId,
    current_price: 0.8,
    current_size: 10,
    current_value: 8,
    entry_cost_usdc: 4,
    outcome: "YES",
    outcome_index: 0,
    percent_pnl: 100,
    percent_realized_pnl: 0,
    proxy_wallet: WALLET,
    realized_pnl: 0,
    status: "OPEN",
    token_id: tokenId,
    total_cost_usdc: 4,
    total_pnl: 4,
    total_size: 10,
    unrealized_pnl: 4,
    opposite_outcome: "NO",
    opposite_token_id: oppositeTokenId,
    end_date: "2026-10-07",
    negative_risk: false,
    redeemable: false,
    ...overrides,
  };
}

function source(args?: {
  discovery?: PolymarketUserPositionV2[];
  hydrated?: PolymarketUserPositionV2[];
  discoveryCalls?: number;
  hydrationCalls?: number;
  status?: PolymarketDataApiStatusV2;
}): PolymarketTargetBookDataSourceV1 & {
  getStatusV2: ReturnType<typeof vi.fn>;
  listPositiveOpenUserPositionsV2: ReturnType<typeof vi.fn>;
  listUserPositionsV2Raw: ReturnType<typeof vi.fn>;
} {
  return {
    getStatusV2: vi.fn().mockResolvedValue(args?.status ?? healthyStatus()),
    listPositiveOpenUserPositionsV2: vi.fn().mockResolvedValue({
      positions: args?.discovery ?? [],
      requestCount: args?.discoveryCalls ?? 1,
    }),
    listUserPositionsV2Raw: vi.fn().mockResolvedValue({
      positions: args?.hydrated ?? [],
      requestCount: args?.hydrationCalls ?? 1,
    }),
  };
}

describe("createPolymarketTargetBookProviderV1", () => {
  it("publishes a deep-frozen complete binary snapshot and synthesizes a proven zero counterpart", async () => {
    const held = row(condition(1), "111", "222");
    const dataSource = source({ discovery: [held], hydrated: [held] });
    const provider = createPolymarketTargetBookProviderV1({
      dataSource,
      now: () => 1_000,
      ttlMs: 10_000,
    });

    const result = await provider.refreshFull(WALLET);

    expect(result.published).toBe(true);
    if (!result.published) throw new Error("expected publication");
    expect(result.snapshot).toMatchObject({
      version: 1,
      targetWallet: WALLET,
      fullRefreshAtMs: 1_000,
      updatedAtMs: 1_000,
      expiresAtMs: 11_000,
      complete: true,
      refreshStats: {
        kind: "full",
        discoveryRows: 1,
        conditionCount: 1,
        dataApiCalls: 3,
        sourceComputedAt: "2026-10-08T02:43:37Z",
        sourceMaxSyncedBlock: 95_148_145,
      },
    });
    expect(result.snapshot.conditions[0]).toMatchObject({
      conditionId: condition(1),
      status: "OPEN",
      redeemable: false,
      endDate: "2026-10-07",
    });
    expect(result.snapshot.conditions[0]?.tokens).toEqual([
      {
        tokenId: "111",
        oppositeTokenId: "222",
        outcomeIndex: 0,
        shares: 10,
        markPrice: 0.8,
        averagePrice: 0.4,
      },
      {
        tokenId: "222",
        oppositeTokenId: "111",
        outcomeIndex: 1,
        shares: 0,
        markPrice: 0,
        averagePrice: 0,
      },
    ]);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.conditions)).toBe(true);
    expect(Object.isFrozen(result.snapshot.conditions[0]?.tokens)).toBe(true);
    expect(provider.readFresh(WALLET)).toBe(result.snapshot);
    expect(dataSource.listUserPositionsV2Raw).toHaveBeenCalledWith(
      WALLET,
      expect.objectContaining({ includeArchived: false })
    );
  });

  it("does not publish a zero-value condition that could become a BUY", async () => {
    const discovered = row(condition(1), "111", "222");
    const zero = row(condition(1), "111", "222", {
      current_price: 0,
      current_value: 0,
    });
    const dataSource = source({ discovery: [discovered], hydrated: [zero] });
    const provider = createPolymarketTargetBookProviderV1({ dataSource });

    const result = await provider.refreshFull(WALLET);

    expect(result.published).toBe(true);
    if (!result.published) throw new Error("expected publication");
    expect(result.snapshot.conditions).toEqual([]);
  });

  it("keeps both held sides and sorts conditions and tokens deterministically", async () => {
    const c1a = row(condition(1), "222", "111", {
      outcome: "NO",
      outcome_index: 1,
      current_size: 4,
      current_price: 0.2,
      current_value: 0.8,
    });
    const c1b = row(condition(1), "111", "222");
    const c2 = row(condition(2), "333", "444");
    const dataSource = source({
      discovery: [c2, c1b],
      hydrated: [c2, c1a, c1b],
    });
    const provider = createPolymarketTargetBookProviderV1({ dataSource });

    const result = await provider.refreshFull(WALLET);

    expect(result.published).toBe(true);
    if (!result.published) throw new Error("expected publication");
    expect(result.snapshot.conditions.map((value) => value.conditionId)).toEqual(
      [condition(1), condition(2)]
    );
    expect(
      result.snapshot.conditions[0]?.tokens.map((value) => value.outcomeIndex)
    ).toEqual([0, 1]);
  });

  it("fails closed on an unproven opposite without replacing last-good", async () => {
    const valid = row(condition(1), "111", "222");
    const invalid = row(condition(1), "111", "111");
    const dataSource = source({ discovery: [valid], hydrated: [valid] });
    const provider = createPolymarketTargetBookProviderV1({ dataSource });
    const first = await provider.refreshFull(WALLET);
    if (!first.published) throw new Error("expected first publication");
    dataSource.listPositiveOpenUserPositionsV2.mockResolvedValue({
      positions: [invalid],
      requestCount: 1,
    });
    dataSource.listUserPositionsV2Raw.mockResolvedValue({
      positions: [invalid],
      requestCount: 1,
    });

    const failed = await provider.refreshFull(WALLET);

    expect(failed).toEqual({
      published: false,
      reason: "malformed",
      retainedSnapshotId: first.snapshot.snapshotId,
    });
    expect(provider.readFresh(WALLET)).toBe(first.snapshot);
  });

  it("rejects more than 500 discovered conditions before hydration", async () => {
    const discovery = Array.from({ length: 501 }, (_, index) =>
      row(condition(index + 1), String(index * 2 + 1), String(index * 2 + 2))
    );
    const dataSource = source({ discovery });
    const provider = createPolymarketTargetBookProviderV1({ dataSource });

    await expect(provider.refreshFull(WALLET)).resolves.toEqual({
      published: false,
      reason: "condition_limit",
      retainedSnapshotId: null,
    });
    expect(dataSource.listUserPositionsV2Raw).not.toHaveBeenCalled();
  });

  it("patches at most 100 dirty conditions without extending full-book freshness", async () => {
    let now = 1_000;
    const held = row(condition(1), "111", "222");
    const dataSource = source({ discovery: [held], hydrated: [held] });
    const provider = createPolymarketTargetBookProviderV1({
      dataSource,
      now: () => now,
      ttlMs: 10_000,
    });
    const first = await provider.refreshFull(WALLET);
    if (!first.published) throw new Error("expected first publication");
    now = 2_000;
    dataSource.listUserPositionsV2Raw.mockResolvedValueOnce({
      positions: [],
      requestCount: 1,
    });

    const patched = await provider.refreshDirty(WALLET, [condition(1)]);

    expect(patched.published).toBe(true);
    if (!patched.published) throw new Error("expected dirty publication");
    expect(patched.snapshot.conditions).toEqual([]);
    expect(patched.snapshot.fullRefreshAtMs).toBe(1_000);
    expect(patched.snapshot.updatedAtMs).toBe(2_000);
    expect(patched.snapshot.expiresAtMs).toBe(11_000);
    expect(patched.snapshot.refreshStats).toEqual({
      kind: "dirty",
      discoveryRows: 1,
      conditionCount: 0,
      dataApiCalls: 2,
      sourceComputedAt: "2026-10-08T02:43:37Z",
      sourceMaxSyncedBlock: 95_148_145,
    });

    const tooMany = Array.from({ length: 101 }, (_, index) =>
      condition(index + 1)
    );
    await expect(provider.refreshDirty(WALLET, tooMany)).resolves.toEqual({
      published: false,
      reason: "condition_limit",
      retainedSnapshotId: patched.snapshot.snapshotId,
    });
  });

  it("reserves exactly five hydration calls plus status for a 100-condition dirty patch", async () => {
    const held = row(condition(1), "111", "222");
    const dataSource = source({ discovery: [held], hydrated: [held] });
    const provider = createPolymarketTargetBookProviderV1({ dataSource });
    const first = await provider.refreshFull(WALLET);
    if (!first.published) throw new Error("expected first publication");
    const dirtyIds = Array.from({ length: 100 }, (_, index) =>
      condition(index + 1)
    );
    dataSource.listUserPositionsV2Raw.mockResolvedValueOnce({
      positions: [],
      requestCount: 5,
    });

    const result = await provider.refreshDirty(WALLET, dirtyIds);

    expect(result.published).toBe(true);
    if (!result.published) throw new Error("expected dirty publication");
    expect(result.snapshot.refreshStats.dataApiCalls).toBe(6);
    expect(dataSource.listUserPositionsV2Raw).toHaveBeenLastCalledWith(
      WALLET,
      expect.objectContaining({ maxRequests: 5 })
    );
  });

  it("refuses dirty IO when the only cached snapshot is stale", async () => {
    let now = 1_000;
    const held = row(condition(1), "111", "222");
    const dataSource = source({ discovery: [held], hydrated: [held] });
    const provider = createPolymarketTargetBookProviderV1({
      dataSource,
      now: () => now,
      ttlMs: 100,
    });
    const first = await provider.refreshFull(WALLET);
    if (!first.published) throw new Error("expected first publication");
    now = 1_101;
    dataSource.listUserPositionsV2Raw.mockClear();

    await expect(
      provider.refreshDirty(WALLET, [condition(1)])
    ).resolves.toEqual({
      published: false,
      reason: "stale_snapshot",
      retainedSnapshotId: first.snapshot.snapshotId,
    });
    expect(dataSource.listUserPositionsV2Raw).not.toHaveBeenCalled();
    expect(provider.readFresh(WALLET)).toBeNull();
  });

  it("fails closed when source freshness is stale and retains last-good", async () => {
    const held = row(condition(1), "111", "222");
    const dataSource = source({ discovery: [held], hydrated: [held] });
    const provider = createPolymarketTargetBookProviderV1({ dataSource });
    const first = await provider.refreshFull(WALLET);
    if (!first.published) throw new Error("expected first publication");
    dataSource.getStatusV2.mockResolvedValue(
      healthyStatus({ age_seconds: 61 })
    );

    await expect(provider.refreshFull(WALLET)).resolves.toEqual({
      published: false,
      reason: "stale_snapshot",
      retainedSnapshotId: first.snapshot.snapshotId,
    });
    expect(provider.readFresh(WALLET)).toBe(first.snapshot);
  });

  it("fails closed when source status reports the wrong chain", async () => {
    const held = row(condition(1), "111", "222");
    const dataSource = source({
      discovery: [held],
      hydrated: [held],
      status: healthyStatus({
        ingestion: {
          cursors: 1,
          network: "ethereum",
          chain_id: 1,
          max_synced_block: 1,
        },
      }),
    });
    const provider = createPolymarketTargetBookProviderV1({ dataSource });

    await expect(provider.refreshFull(WALLET)).resolves.toEqual({
      published: false,
      reason: "malformed",
      retainedSnapshotId: null,
    });
  });
});
