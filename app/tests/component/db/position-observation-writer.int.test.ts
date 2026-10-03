// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/position-observation-writer`
 * Purpose: Real-Postgres proofs for the serialized current-position writer.
 * Scope: Writer transaction/CAS behavior with fake read-only upstreams.
 * Invariants:
 *   - ZERO_ONLY_DEACTIVATES: nonzero dust publishes no snapshot/current rows.
 *   - XMIN_BEATS_SAME_TIMESTAMP: cursor updates sharing last_success_at still
 *     supersede an older preparation.
 *   - LOCKED_OMISSION_RECHECK: a current row appearing after chain
 *     classification forces one full retry before any publication.
 * Side-effects: testcontainers Postgres only.
 * Links: work item subtask.5000
 * @public
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import type {
  PolymarketDataApiClient,
  PolymarketUserPosition,
} from "@cogni/poly-market-provider/adapters/polymarket";
import {
  polyMarketOutcomes,
  polyTraderCurrentPositions,
  polyTraderIngestionCursors,
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  refreshCurrentPositionsForWallet,
} from "@/features/wallet-analysis/server/trader-observation-service";

type WriterDb = Parameters<typeof refreshCurrentPositionsForWallet>[0]["db"];

const seededWalletIds: string[] = [];
const seededOutcomeTokenIds: string[] = [];

function position(tokenId: string): PolymarketUserPosition {
  return {
    proxyWallet: `0x${"f".repeat(40)}`,
    asset: tokenId,
    conditionId: `condition-${tokenId}`,
    size: 10,
    avgPrice: 0.4,
    initialValue: 4,
    currentValue: 5,
    cashPnl: 1,
    percentPnl: 25,
    totalBought: 4,
    realizedPnl: 0,
    percentRealizedPnl: 0,
    curPrice: 0.5,
    redeemable: false,
    mergeable: false,
    title: `market ${tokenId}`,
    slug: `market-${tokenId}`,
    icon: "",
    eventId: `event-${tokenId}`,
    eventSlug: `event-${tokenId}`,
    outcome: "Yes",
    outcomeIndex: 0,
    oppositeOutcome: "No",
    oppositeAsset: `${tokenId}9`,
    endDate: "2027-01-01",
    negativeRisk: false,
  };
}

async function seedWallet(suffix: string): Promise<{
  id: string;
  address: string;
  lastSuccessAt: Date;
}> {
  const db = getSeedDb();
  const address = `0x${suffix.padStart(40, "0")}`;
  const [wallet] = await db
    .insert(polyTraderWallets)
    .values({ walletAddress: address, kind: "cogni_wallet", label: suffix })
    .returning({ id: polyTraderWallets.id });
  if (!wallet) throw new Error("failed to seed writer wallet");
  seededWalletIds.push(wallet.id);
  const lastSuccessAt = new Date("2026-10-03T20:00:00.123Z");
  await db.insert(polyTraderIngestionCursors).values({
    traderWalletId: wallet.id,
    source: "data-api-positions",
    lastSuccessAt,
    status: "ok",
  });
  return { id: wallet.id, address, lastSuccessAt };
}

async function seedCurrent(
  walletId: string,
  tokenId: string
): Promise<void> {
  await getSeedDb().insert(polyTraderCurrentPositions).values({
    traderWalletId: walletId,
    conditionId: `condition-${tokenId}`,
    tokenId,
    shares: "10",
    costBasisUsdc: "4",
    currentValueUsdc: "5",
    avgPrice: "0.4",
    contentHash: `old-${tokenId}`,
    lastObservedAt: new Date("2026-10-03T19:00:00.000Z"),
  });
}

async function seedLoser(tokenId: string): Promise<void> {
  seededOutcomeTokenIds.push(tokenId);
  await getSeedDb()
    .insert(polyMarketOutcomes)
    .values({
      conditionId: `condition-${tokenId}`,
      tokenId,
      outcome: "loser",
    })
    .onConflictDoUpdate({
      target: [polyMarketOutcomes.conditionId, polyMarketOutcomes.tokenId],
      set: { outcome: "loser" },
    });
}

function clientReturning(
  read: () => Promise<PolymarketUserPosition[]>
): PolymarketDataApiClient {
  return { listUserPositions: read } as unknown as PolymarketDataApiClient;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("serialized position-observation writer", () => {
  afterAll(async () => {
    if (seededOutcomeTokenIds.length > 0) {
      await getSeedDb()
        .delete(polyMarketOutcomes)
        .where(inArray(polyMarketOutcomes.tokenId, seededOutcomeTokenIds));
    }
    if (seededWalletIds.length > 0) {
      await getSeedDb()
        .delete(polyTraderWallets)
        .where(inArray(polyTraderWallets.id, seededWalletIds));
    }
  });

  it("publishes exact-zero omissions atomically", async () => {
    const wallet = await seedWallet("5101");
    await seedCurrent(wallet.id, "101");
    const logger = { info: vi.fn() };

    const result = await refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => []),
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) =>
        tokenIds.map(() => 0n),
      logger: logger as never,
    });

    expect(result).toMatchObject({
      complete: true,
      stalePositionRowsDeactivated: 1,
      stalePositionRowsPreserved: 0,
    });
    const [current] = await getSeedDb()
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current).toMatchObject({ active: false, shares: "0.00000000" });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "poly.trader.positions.publish",
        status: "published",
        reason: "complete_all_zero",
        pages: 1,
        observed_count: 0,
        classified_count: 1,
        zero_count: 1,
        nonzero_count: 0,
        chunk_count: 1,
        cursor_before_status: "ok",
        cursor_after_status: "ok",
        published: true,
      }),
      "trader positions publication finished"
    );
  });

  it("treats nonzero dust as nonfresh and publishes none of the fetched rows", async () => {
    const wallet = await seedWallet("5102");
    await seedCurrent(wallet.id, "201");

    const result = await refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => [position("202")]),
      walletAddress: wallet.address,
      readPositionBalances: async () => [1n],
    });

    expect(result).toMatchObject({
      complete: false,
      positionRows: 0,
      failureReason: "authority_nonzero",
      stalePositionRowsPreserved: 1,
    });
    const current = await getSeedDb()
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ tokenId: "201", active: true });
    const snapshots = await getSeedDb()
      .select()
      .from(polyTraderPositionSnapshots)
      .where(eq(polyTraderPositionSnapshots.traderWalletId, wallet.id));
    expect(snapshots).toHaveLength(0);
    const [cursor] = await getSeedDb()
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    expect(cursor?.lastSuccessAt).toEqual(wallet.lastSuccessAt);
    expect(cursor?.status).toBe("stale");
  });

  it("keeps a Data-API-returned resolved loser inactive on successful publish", async () => {
    const wallet = await seedWallet("5106");
    await seedCurrent(wallet.id, "601");
    await seedLoser("601");

    const result = await refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => [position("601")]),
      walletAddress: wallet.address,
      readPositionBalances: async () => [],
    });

    expect(result.complete).toBe(true);
    const [current] = await getSeedDb()
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current).toMatchObject({ tokenId: "601", active: false });
  });

  it("uses xmin to exhaust two same-timestamp superseded attempts without writes", async () => {
    const wallet = await seedWallet("5103");
    await seedCurrent(wallet.id, "301");
    let calls = 0;
    let authorityCalls = 0;
    const client = clientReturning(async () => {
      calls += 1;
      await getSeedDb()
        .update(polyTraderIngestionCursors)
        .set({ status: "pending", errorMessage: `racer-${calls}` })
        .where(
          and(
            eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
            eq(polyTraderIngestionCursors.source, "data-api-positions")
          )
        );
      return [];
    });

    const result = await refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client,
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) => {
        authorityCalls += 1;
        return tokenIds.map(() => 0n);
      },
    });

    expect(calls).toBe(2);
    expect(authorityCalls).toBe(2);
    expect(result).toMatchObject({
      complete: false,
      positionRows: 0,
      failureReason: "superseded_exhausted",
    });
    const [current] = await getSeedDb()
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current?.active).toBe(true);
    const [cursor] = await getSeedDb()
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    expect(cursor?.lastSuccessAt).toEqual(wallet.lastSuccessAt);
    expect(cursor?.errorMessage).toBe("racer-2");
  });

  it("supersedes the older preparation when the newer writer publishes first", async () => {
    const wallet = await seedWallet("5109");
    await seedCurrent(wallet.id, "901");
    const olderStarted = deferred();
    const newerStarted = deferred();
    const releaseOlder = deferred();
    const releaseNewer = deferred();
    let olderCalls = 0;
    let newerCalls = 0;
    const older = refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => {
        olderCalls += 1;
        if (olderCalls === 1) {
          olderStarted.resolve();
          await releaseOlder.promise;
        }
        return [];
      }),
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) =>
        tokenIds.map(() => 0n),
    });
    await olderStarted.promise;
    const newer = refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => {
        newerCalls += 1;
        newerStarted.resolve();
        await releaseNewer.promise;
        return [];
      }),
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) =>
        tokenIds.map(() => 0n),
    });
    await newerStarted.promise;
    releaseNewer.resolve();
    const newerResult = await newer;
    releaseOlder.resolve();
    const olderResult = await older;

    expect(newerResult.complete).toBe(true);
    expect(olderResult.complete).toBe(true);
    expect(newerCalls).toBe(1);
    expect(olderCalls).toBe(2);
  });

  it("retries the newer preparation when the older writer publishes first", async () => {
    const wallet = await seedWallet("5110");
    await seedCurrent(wallet.id, "1001");
    const olderStarted = deferred();
    const newerStarted = deferred();
    const releaseOlder = deferred();
    const releaseNewer = deferred();
    let olderCalls = 0;
    let newerCalls = 0;
    const older = refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => {
        olderCalls += 1;
        olderStarted.resolve();
        await releaseOlder.promise;
        return [];
      }),
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) =>
        tokenIds.map(() => 0n),
    });
    await olderStarted.promise;
    const newer = refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => {
        newerCalls += 1;
        if (newerCalls === 1) {
          newerStarted.resolve();
          await releaseNewer.promise;
        }
        return [];
      }),
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) =>
        tokenIds.map(() => 0n),
    });
    await newerStarted.promise;
    releaseOlder.resolve();
    const olderResult = await older;
    releaseNewer.resolve();
    const newerResult = await newer;

    expect(olderResult.complete).toBe(true);
    expect(newerResult.complete).toBe(true);
    expect(olderCalls).toBe(1);
    expect(newerCalls).toBe(2);
  });

  it("retries when the locked omission re-read finds an unclassified row", async () => {
    const wallet = await seedWallet("5104");
    await seedCurrent(wallet.id, "401");
    let authorityCalls = 0;

    const result = await refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => []),
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) => {
        authorityCalls += 1;
        if (authorityCalls === 1) await seedCurrent(wallet.id, "402");
        return tokenIds.map(() => 0n);
      },
    });

    expect(authorityCalls).toBe(2);
    expect(result).toMatchObject({
      complete: true,
      stalePositionRowsDeactivated: 2,
    });
    const rows = await getSeedDb()
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !row.active)).toBe(true);
  });

  it("stops at the 5,001-row omission sentinel without calling Polygon", async () => {
    const wallet = await seedWallet("5107");
    const now = new Date("2026-10-03T19:00:00.000Z");
    await getSeedDb().insert(polyTraderCurrentPositions).values(
      Array.from({ length: 5_001 }, (_value, index) => ({
        traderWalletId: wallet.id,
        conditionId: `large-condition-${index}`,
        tokenId: `7${String(index).padStart(6, "0")}`,
        shares: "1",
        costBasisUsdc: "1",
        currentValueUsdc: "1",
        avgPrice: "0.5",
        contentHash: `large-${index}`,
        lastObservedAt: now,
      }))
    );
    const authority = vi.fn(async () => [] as bigint[]);

    const result = await refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => []),
      walletAddress: wallet.address,
      readPositionBalances: authority,
    });

    expect(result).toMatchObject({
      complete: false,
      failureReason: "omission_over_cap",
      stalePositionRowsPreserved: 5_001,
    });
    expect(authority).not.toHaveBeenCalled();
  });

  it("propagates abort after an empty omission read before opening publish", async () => {
    const wallet = await seedWallet("5108");
    const controller = new AbortController();
    const logger = { info: vi.fn() };

    await expect(
      refreshCurrentPositionsForWallet({
        db: getSeedDb() as unknown as WriterDb,
        client: clientReturning(async () => {
          controller.abort(new Error("test cancellation"));
          return [];
        }),
        walletAddress: wallet.address,
        signal: controller.signal,
        logger: logger as never,
      })
    ).rejects.toThrow("test cancellation");

    const [cursor] = await getSeedDb()
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    expect(cursor).toMatchObject({ status: "ok" });
    expect(cursor?.lastSuccessAt).toEqual(wallet.lastSuccessAt);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("rolls back snapshot and current rows when cursor publication fails", async () => {
    const wallet = await seedWallet("5105");
    await seedCurrent(wallet.id, "501");
    await seedLoser("501");
    const db = getSeedDb();
    await expect(
      refreshCurrentPositionsForWallet({
        db: db as unknown as WriterDb,
        client: clientReturning(async () => [position("501"), position("502")]),
        walletAddress: wallet.address,
        readPositionBalances: async () => [],
        beforePositionCursorPublish: () => {
          throw new Error("injected cursor publish failure");
        },
      })
    ).rejects.toThrow("injected cursor publish failure");

    const current = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const snapshots = await db
      .select()
      .from(polyTraderPositionSnapshots)
      .where(eq(polyTraderPositionSnapshots.traderWalletId, wallet.id));
    const [cursor] = await db
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ tokenId: "501", active: true });
    expect(snapshots).toHaveLength(0);
    expect(cursor).toMatchObject({
      status: "ok",
      lastSuccessAt: wallet.lastSuccessAt,
    });
  });
});
