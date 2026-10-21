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
  refreshCurrentPositionsForWallet as refreshWithProductionControl,
  PositionObservationController,
  PositionBalanceTransportError,
  runTraderObservationTick,
} from "@/features/wallet-analysis/server/trader-observation-service";

// Writer/CAS fixtures simulate independent processes and elapsed eligibility.
// Dedicated floor/coalescing cases below use the actual shared controller.
function refreshCurrentPositionsForWallet(
  input: Parameters<typeof refreshWithProductionControl>[0]
) {
  return refreshWithProductionControl({
    ...input,
    positionControl: new PositionObservationController({
      now: () => Date.now() + 60_000,
    }),
  });
}

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
    updatedAt: lastSuccessAt,
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

/** Keep real scheduled SQL/cursors scoped to this fixture's enrolled wallet. */
function scheduledDb(walletId: string): WriterDb {
  type FixtureDb = ReturnType<typeof getSeedDb>;
  const wrap = (db: FixtureDb): FixtureDb =>
    new Proxy(db, {
      get(target, key) {
        if (key === "transaction")
          return (run: (tx: FixtureDb) => Promise<unknown>) =>
            target.transaction((tx) => run(wrap(tx as unknown as FixtureDb)));
        if (key === "select")
          return (...args: []) => {
            const builder = target.select(...args);
            const from = builder.from.bind(builder);
            return new Proxy(builder, {
              get(select, property) {
                if (property !== "from") return Reflect.get(select, property);
                return (...fromArgs: Parameters<typeof from>) => {
                  const query = from(...fromArgs);
                  if (fromArgs[0] !== polyTraderWallets) return query;
                  const where = query.where.bind(query);
                  return new Proxy(query, {
                    get(current, operation) {
                      if (operation === "where")
                        return (condition: Parameters<typeof where>[0]) =>
                          where(
                            and(condition, eq(polyTraderWallets.id, walletId))
                          );
                      const value = Reflect.get(current, operation);
                      return typeof value === "function"
                        ? value.bind(current)
                        : value;
                    },
                  });
                };
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return wrap(getSeedDb()) as unknown as WriterDb;
}

async function positionCursor(walletId: string) {
  const [cursor] = await getSeedDb()
    .select()
    .from(polyTraderIngestionCursors)
    .where(
      and(
        eq(polyTraderIngestionCursors.traderWalletId, walletId),
        eq(polyTraderIngestionCursors.source, "data-api-positions")
      )
    );
  if (!cursor) throw new Error("missing position cursor");
  return cursor;
}

function scheduledLogger() {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
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

  it("publishes (not wedges) when an OMITTED resolved loser still holds nonzero on-chain balance (bug.5031)", async () => {
    // The exact prod deadlock: a market resolved AFTER the last good page, so
    // Data-API now drops the worthless loser token while it still has nonzero
    // CTF balance on-chain. Previously that tripped the authority_nonzero
    // omission guard and wedged the observer stale forever. The resolved-market
    // exclusion keeps the loser OUT of the blocking authority guard; its
    // separate nonblocking terminal probe must not prevent publication.
    const wallet = await seedWallet("5111");
    await seedCurrent(wallet.id, "701");
    await seedLoser("701");
    let authorityCalls = 0;

    const result = await refreshCurrentPositionsForWallet({
      db: getSeedDb() as unknown as WriterDb,
      client: clientReturning(async () => []), // 701 omitted by Data-API
      walletAddress: wallet.address,
      // Terminal nonzero balances are reconsidered, without blocking the book.
      readPositionBalances: async ({ tokenIds }) => {
        authorityCalls += 1;
        return tokenIds.map(() => 1n);
      },
    });

    expect(result.complete).toBe(true);
    expect(result.failureReason).toBeUndefined();
    expect(authorityCalls).toBe(1); // nonblocking terminal probe
    const [current] = await getSeedDb()
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current).toMatchObject({ tokenId: "701", active: false });
    expect(current?.lastObservedAt).toEqual(
      new Date("2026-10-03T19:00:00.000Z")
    );
    const [cursor] = await getSeedDb()
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    expect(cursor?.status).toBe("ok");
    expect(cursor?.lastSuccessAt.getTime()).toBeGreaterThan(
      wallet.lastSuccessAt.getTime()
    );
  });

  it("publishes an upstream-resolved/local-unknown positive loser from one unfiltered generation", async () => {
    const wallet = await seedWallet("5301");
    const db = getSeedDb();
    await seedCurrent(
      wallet.id,
      "99798412202061844296554197418242298152132976034106523029789637090660271866146"
    );
    const token =
      "99798412202061844296554197418242298152132976034106523029789637090660271866146";
    const economicObservationV1 = {
      version: 1,
      fetchedAt: "2026-10-03T18:00:00Z",
    };
    await db
      .update(polyTraderCurrentPositions)
      .set({ raw: { redeemable: false, economicObservationV1 } })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const loser = {
      ...position(token),
      size: 21.14,
      redeemable: true,
      currentValue: 0,
      curPrice: 0,
    };
    const listUserPositions = vi.fn(
      async (_wallet: string, params: unknown) => {
        expect(params).not.toHaveProperty("redeemable");
        return [loser, position("5302")];
      }
    );
    const readPositionBalances = vi.fn(async () => [21_140_000n]);
    const result = await refreshCurrentPositionsForWallet({
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client: { listUserPositions } as unknown as PolymarketDataApiClient,
      readPositionBalances,
    });
    expect(result).toMatchObject({ complete: true, positionRows: 2 });
    expect(readPositionBalances).not.toHaveBeenCalled();
    const current = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current.find((row) => row.tokenId === token)).toMatchObject({
      active: false,
      shares: "21.14000000",
      currentValueUsdc: "0.00000000",
      raw: { redeemable: true, economicObservationV1 },
    });
    expect(current.find((row) => row.tokenId === "5302")).toMatchObject({
      active: true,
      currentValueUsdc: "5.00000000",
    });
  });

  it("enforces the completed-attempt explicit floor across fresh service instances", async () => {
    const wallet = await seedWallet("5303");
    const db = getSeedDb();
    const client = clientReturning(vi.fn(async () => [position("5303")]));
    const first = await refreshWithProductionControl({
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client,
    });
    expect(first.complete).toBe(true);
    const [cursor] = await db
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    const reader = vi.mocked(client.listUserPositions);
    const restart = await refreshWithProductionControl({
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client,
      positionControl: new PositionObservationController({
        now: () => (cursor?.updatedAt.getTime() ?? 0) + 29_999,
      }),
    });
    expect(restart).toMatchObject({
      deferred: "floor",
      complete: false,
      originalAsOf: cursor?.lastSuccessAt.toISOString(),
    });
    expect(reader).toHaveBeenCalledTimes(1);
    const due = await refreshWithProductionControl({
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client,
      positionControl: new PositionObservationController({
        now: () => (cursor?.updatedAt.getTime() ?? 0) + 30_001,
      }),
    });
    expect(due.complete).toBe(true);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it("backs off failed attempts for thirty seconds across restart without changing inventory as-of", async () => {
    const wallet = await seedWallet("5304");
    const db = getSeedDb();
    const client = clientReturning(
      vi.fn(async () => {
        throw new Error("semantic vendor failure");
      })
    );
    expect(
      await refreshWithProductionControl({
        db: db as unknown as WriterDb,
        walletAddress: wallet.address,
        client,
      })
    ).toMatchObject({ complete: false, failureReason: "data_api_error" });
    const [cursor] = await db
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    expect(cursor?.lastSuccessAt).toEqual(wallet.lastSuccessAt);
    const deps = {
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client,
    };
    if (!cursor) throw new Error("missing failed cursor");
    expect(
      await refreshWithProductionControl({
        ...deps,
        positionControl: new PositionObservationController({
          now: () => cursor.updatedAt.getTime() + 29_999,
        }),
      })
    ).toMatchObject({ deferred: "floor", complete: false });
    expect(client.listUserPositions).toHaveBeenCalledTimes(1);
    await refreshWithProductionControl({
      ...deps,
      positionControl: new PositionObservationController({
        now: () => cursor.updatedAt.getTime() + 30_001,
      }),
    });
    expect(client.listUserPositions).toHaveBeenCalledTimes(2);
  });

  it("starts a successful explicit-refresh floor at completion even when inventory capture is old", async () => {
    const wallet = await seedWallet("5306");
    const db = getSeedDb();
    // Simulate a preparation held for >30s without a real blocking sleep.
    // Actual SQL publication/clock_timestamp and cursor reads remain real PG.
    const delayedDb = new Proxy(db, {
      get(target, property) {
        if (property === "execute")
          return async (query: Parameters<typeof db.execute>[0]) => {
            const result = await target.execute(query);
            const rows = result as unknown as { captured_at?: string }[];
            if (rows[0]?.captured_at)
              rows[0].captured_at = new Date(Date.now() - 35_000).toISOString();
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const read = vi.fn(async () => [position("5306")]);
    const client = clientReturning(read);
    expect(
      await refreshWithProductionControl({
        db: delayedDb as unknown as WriterDb,
        client,
        walletAddress: wallet.address,
      })
    ).toMatchObject({ complete: true });
    const [cursor] = await db
      .select()
      .from(polyTraderIngestionCursors)
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    if (!cursor?.lastSuccessAt) throw new Error("missing completed success");
    expect(
      cursor.updatedAt.getTime() - cursor.lastSuccessAt.getTime()
    ).toBeGreaterThan(34_000);
    const result = await refreshWithProductionControl({
      db: db as unknown as WriterDb,
      client,
      walletAddress: wallet.address,
    });
    expect(result).toMatchObject({
      complete: false,
      deferred: "floor",
      originalAsOf: cursor.lastSuccessAt.toISOString(),
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retains admission through an aborted but still-running publication transaction", async () => {
    const wallet = await seedWallet("5305");
    const control = new PositionObservationController();
    const runs = vi.spyOn(control, "run");
    const entered = deferred();
    const release = deferred();
    const abort = new AbortController();
    const client = clientReturning(vi.fn(async () => [position("5305")]));
    const deps = {
      db: getSeedDb() as unknown as WriterDb,
      walletAddress: wallet.address,
      client,
      positionControl: control,
    };
    const owner = refreshWithProductionControl({
      ...deps,
      signal: abort.signal,
      beforePositionCursorPublish: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const ownerCheck = expect(owner).rejects.toThrow("cancelled publication");
    await entered.promise;
    abort.abort(new Error("cancelled publication"));
    expect(control.activeCount).toBe(1);
    const joining = refreshWithProductionControl(deps);
    const joinCheck = expect(joining).rejects.toThrow("cancelled publication");
    // Let the joiner's wallet upsert complete before releasing the DB writer.
    await vi.waitFor(() => expect(runs).toHaveBeenCalledTimes(2));
    expect(client.listUserPositions).toHaveBeenCalledTimes(1);
    expect(control.activeCount).toBe(1);
    release.resolve();
    await Promise.all([ownerCheck, joinCheck]);
    expect(control.activeCount).toBe(0);
    const rows = await getSeedDb()
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(rows).toEqual([]);
  });

  it("retains an unredeemed inactive winner, then publishes a real zero without losing history or touching another wallet", async () => {
    const wallet = await seedWallet("5201");
    const other = await seedWallet("5202");
    const db = getSeedDb();
    await seedCurrent(other.id, "9101");
    const deps = {
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
    };
    const winner = { ...position("9101"), redeemable: true, currentValue: 10 };
    await refreshCurrentPositionsForWallet({
      ...deps,
      client: clientReturning(async () => [winner]),
    });
    const readWinner = async () =>
      (
        await db
          .select()
          .from(polyTraderCurrentPositions)
          .where(
            and(
              eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
              eq(polyTraderCurrentPositions.tokenId, "9101")
            )
          )
      )[0];
    const original = await readWinner();
    expect(original).toMatchObject({ active: false, shares: "10.00000000" });
    const economicObservationV1 = {
      version: 1,
      fetchedAt: "2026-10-03T18:00:00Z",
    };
    await db
      .update(polyTraderCurrentPositions)
      .set({ raw: { ...winner, economicObservationV1 } })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const held = await refreshCurrentPositionsForWallet({
      ...deps,
      client: clientReturning(async () => [position("9102")]),
      readPositionBalances: async ({ tokenIds }) => {
        expect(tokenIds).toEqual(["9101"]);
        return [1n];
      },
    });
    expect(held.complete).toBe(true);
    expect(await readWinner()).toMatchObject({
      active: false,
      shares: "10.00000000",
      currentValueUsdc: "10.00000000",
      lastObservedAt: original?.lastObservedAt,
      raw: { economicObservationV1 },
    });
    const redeemed = await refreshCurrentPositionsForWallet({
      ...deps,
      client: clientReturning(async () => [position("9102")]),
      readPositionBalances: async () => [0n],
    });
    expect(redeemed.complete).toBe(true);
    const zero = await readWinner();
    expect(zero).toMatchObject({
      active: false,
      shares: "0.00000000",
      currentValueUsdc: "0.00000000",
      raw: { economicObservationV1 },
    });
    expect(zero?.lastObservedAt.getTime()).toBeGreaterThan(
      original?.lastObservedAt.getTime() ?? 0
    );
    const snapshots = await db
      .select()
      .from(polyTraderPositionSnapshots)
      .where(
        and(
          eq(polyTraderPositionSnapshots.traderWalletId, wallet.id),
          eq(polyTraderPositionSnapshots.tokenId, "9101")
        )
      );
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.shares).toBe("10.00000000");
    const [untouched] = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, other.id));
    expect(untouched).toMatchObject({ active: true, shares: "10.00000000" });
  });

  it("publishes healthy inventory on terminal RPC failure without rejuvenating retained terminal facts", async () => {
    const wallet = await seedWallet("5203");
    const db = getSeedDb();
    await seedCurrent(wallet.id, "9201");
    await db
      .update(polyTraderCurrentPositions)
      .set({ raw: { redeemable: true } })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const result = await refreshCurrentPositionsForWallet({
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client: clientReturning(async () => [position("9202")]),
      readPositionBalances: async () => {
        throw new Error("RPC unavailable");
      },
    });
    expect(result.complete).toBe(true);
    const current = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current.find((row) => row.tokenId === "9201")).toMatchObject({
      active: false,
      shares: "10.00000000",
      currentValueUsdc: "5.00000000",
      lastObservedAt: new Date("2026-10-03T19:00:00.000Z"),
    });
    expect(current.find((row) => row.tokenId === "9202")?.active).toBe(true);
    const [cursor] = await db
      .select()
      .from(polyTraderIngestionCursors)
      .where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
    expect(JSON.parse(cursor?.lastSeenNativeId ?? "null")).toEqual([
      "condition-9201",
      "9201",
    ]);
  });

  it("recovers failed terminal authority through the real scheduler after DB completion, including restart and explicit-floor parity", async () => {
    const wallet = await seedWallet("5401");
    const db = getSeedDb();
    await seedCurrent(wallet.id, "54011");
    seededOutcomeTokenIds.push("54011");
    await db
      .insert(polyMarketOutcomes)
      .values({
        conditionId: "condition-54011",
        tokenId: "54011",
        outcome: "winner",
      });
    const evidence = { version: 1, native: "trusted" };
    await db
      .update(polyTraderCurrentPositions)
      .set({ active: false, raw: { economicObservationV1: evidence } })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const old = (
      await db
        .select()
        .from(polyTraderCurrentPositions)
        .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id))
    )[0];
    const read = vi.fn(async () => [position("54012")]);
    const authority = vi
      .fn<
        NonNullable<
          Parameters<
            typeof refreshWithProductionControl
          >[0]["readPositionBalances"]
        >
      >()
      .mockRejectedValueOnce(new PositionBalanceTransportError("503"))
      .mockRejectedValueOnce(new PositionBalanceTransportError("503"))
      .mockResolvedValue([0n]);
    const logger = scheduledLogger();
    const client = {
      listUserPositions: read,
      listUserActivity: vi.fn(async () => []),
    } as unknown as PolymarketDataApiClient;
    const tick = (control: PositionObservationController, delayed = false) =>
      runTraderObservationTick({
        db: scheduledDb(wallet.id),
        client,
        listActiveTradingAddresses: async () => {
          throw new Error("fixture already enrolled");
        },
        logger: logger as never,
        metrics: { incr: vi.fn(), observeDurationMs: vi.fn() },
        runRetentionPrune: false,
        positionControl: control,
        readPositionBalances: authority,
        ...(delayed
          ? {
              beforePositionCursorPublish: async () => {
                await new Promise((resolve) => setTimeout(resolve, 80));
              },
            }
          : {}),
      });
    expect(
      (
        await tick(
          new PositionObservationController({
            wait: async () => {},
            random: () => 0,
          }),
          true
        )
      ).positions
    ).toBe(1);
    expect(authority).toHaveBeenCalledTimes(2);
    const failed = await positionCursor(wallet.id);
    expect(failed.status).toBe("ok");
    expect(failed.errorMessage).toBe(
      'terminal_recovery_v1:{"reason":"authority_unavailable","anchor":["condition-54011","54011"]}'
    );
    expect(failed.lastErrorAt).toEqual(failed.updatedAt);
    expect(
      failed.updatedAt.getTime() - (failed.lastSuccessAt?.getTime() ?? 0)
    ).toBeGreaterThanOrEqual(60);
    const retained = (
      await db
        .select()
        .from(polyTraderCurrentPositions)
        .where(
          and(
            eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
            eq(polyTraderCurrentPositions.tokenId, "54011")
          )
        )
    )[0];
    expect(retained).toEqual(old);
    expect(
      (
        await tick(
          new PositionObservationController({
            now: () => failed.updatedAt.getTime() + 29_999,
          })
        )
      ).positions
    ).toBe(0);
    expect(
      await refreshWithProductionControl({
        db: db as unknown as WriterDb,
        client,
        walletAddress: wallet.address,
        positionControl: new PositionObservationController({
          now: () => failed.updatedAt.getTime() + 29_999,
        }),
        readPositionBalances: authority,
      })
    ).toMatchObject({ deferred: "floor" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(authority).toHaveBeenCalledTimes(2);
    expect(
      (
        await tick(
          new PositionObservationController({
            now: () => failed.updatedAt.getTime() + 31_000,
          })
        )
      ).positions
    ).toBe(1);
    expect(authority).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledTimes(2);
    const recovered = await positionCursor(wallet.id);
    expect(recovered.status).toBe("ok");
    expect(recovered.errorMessage).toBeNull();
    const closed = (
      await db
        .select()
        .from(polyTraderCurrentPositions)
        .where(
          and(
            eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
            eq(polyTraderCurrentPositions.tokenId, "54011")
          )
        )
    )[0];
    expect(closed).toMatchObject({
      active: false,
      shares: "0.00000000",
      currentValueUsdc: "0.00000000",
      raw: { economicObservationV1: evidence },
      lastObservedAt: recovered.lastSuccessAt,
    });
    expect(
      (
        await tick(
          new PositionObservationController({
            now: () => recovered.updatedAt.getTime() + 31_000,
          })
        )
      ).positions
    ).toBe(0);
    expect(authority).toHaveBeenCalledTimes(3);
    expect(
      logger.info.mock.calls.some(
        ([data]) =>
          data.event === "poly.trader.positions.publish" &&
          data.terminal_recovery_pending === true &&
          data.recovery_eligibility_ms === 30_000
      )
    ).toBe(true);
    expect(
      logger.info.mock.calls.some(
        ([data]) =>
          data.event === "poly.trader.positions.publish" &&
          data.terminal_recovery_action === "cleared" &&
          data.terminal_recovery_pending === false
      )
    ).toBe(true);
  });

  it("persists malformed terminal recovery without retry and clears invalid reserved state only after an actual complete pass", async () => {
    const wallet = await seedWallet("5402");
    const db = getSeedDb();
    await seedCurrent(wallet.id, "54021");
    await db
      .update(polyTraderCurrentPositions)
      .set({ active: false })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const authority = vi.fn(async () => [] as bigint[]);
    const input = {
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client: clientReturning(async () => [position("54022")]),
      readPositionBalances: authority,
    };
    expect((await refreshCurrentPositionsForWallet(input)).complete).toBe(true);
    expect(authority).toHaveBeenCalledTimes(1);
    const malformed = await positionCursor(wallet.id);
    expect(malformed.errorMessage).toContain('"reason":"authority_malformed"');
    expect(malformed.status).toBe("ok");
    expect(
      await refreshWithProductionControl({
        ...input,
        positionControl: new PositionObservationController({
          now: () => malformed.updatedAt.getTime() + 29_999,
        }),
      })
    ).toMatchObject({ deferred: "floor" });
    await db
      .update(polyTraderIngestionCursors)
      .set({ errorMessage: "terminal_recovery_v9:broken" })
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    expect(
      (
        await refreshCurrentPositionsForWallet({
          ...input,
          readPositionBalances: async () => [1n],
        })
      ).complete
    ).toBe(true);
    expect((await positionCursor(wallet.id)).errorMessage).toBeNull();
    const [retained] = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(
        and(
          eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
          eq(polyTraderCurrentPositions.tokenId, "54021")
        )
      );
    expect(retained).toMatchObject({
      shares: "10.00000000",
      lastObservedAt: new Date("2026-10-03T19:00:00Z"),
    });
  });

  it("carries a failed anchor through an ordinary outage and a different fair prefix, then clears after a real 5001-row recovery sweep", async () => {
    const wallet = await seedWallet("5403");
    const db = getSeedDb();
    const rows = Array.from({ length: 5_001 }, (_, i) => ({
      traderWalletId: wallet.id,
      conditionId: "terminal-recovery",
      tokenId: String(200_000 + i),
      active: false,
      shares: "10",
      costBasisUsdc: "4",
      currentValueUsdc: "5",
      avgPrice: "0.4",
      contentHash: `recovery-${i}`,
      lastObservedAt: new Date("2026-10-03T19:00:00Z"),
    }));
    for (let i = 0; i < rows.length; i += 500)
      await db
        .insert(polyTraderCurrentPositions)
        .values(rows.slice(i, i + 500));
    const read = vi.fn(async () => [position("54032")]);
    const chunks: string[][] = [];
    let failing = true;
    const authority = async ({ tokenIds }: { tokenIds: readonly string[] }) => {
      chunks.push([...tokenIds]);
      if (failing) throw new PositionBalanceTransportError("503");
      return tokenIds.map(() => 1n);
    };
    const input = {
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client: clientReturning(read),
      readPositionBalances: authority,
    };
    const refresh = () =>
      refreshWithProductionControl({
        ...input,
        positionControl: new PositionObservationController({
          now: () => Date.now() + 60_000,
          wait: async () => {},
        }),
      });
    expect((await refresh()).complete).toBe(true);
    expect(chunks).toHaveLength(2);
    const failed = await positionCursor(wallet.id);
    const anchor = failed.errorMessage;
    expect(anchor).toContain('"anchor":["terminal-recovery","200099"]');
    read.mockRejectedValueOnce(
      new Error("Data API outage\nterminal_recovery_v1:provider-injection")
    );
    expect((await refresh()).complete).toBe(false);
    const outage = await positionCursor(wallet.id);
    expect(outage.errorMessage?.startsWith("data_api_error: ")).toBe(true);
    expect(outage.errorMessage?.endsWith(anchor ?? "missing")).toBe(true);
    expect(outage.lastSeenNativeId).toBe(failed.lastSeenNativeId);
    expect(outage.updatedAt.getTime()).toBeGreaterThanOrEqual(
      failed.updatedAt.getTime()
    );
    chunks.length = 0;
    failing = false;
    expect((await refresh()).complete).toBe(true);
    expect(chunks).toHaveLength(50);
    expect(chunks.flat()).toHaveLength(5_000);
    expect(chunks[0]?.[0]).toBe("200100");
    const different = await positionCursor(wallet.id);
    expect(different.status).toBe("ok");
    expect(different.errorMessage).toBe(anchor);
    expect(different.lastSeenNativeId).toBe('["terminal-recovery","200098"]');
    expect((await refresh()).complete).toBe(true);
    expect(chunks).toHaveLength(100);
    const recovered = await positionCursor(wallet.id);
    expect(recovered.errorMessage).toBeNull();
    const [retained] = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(
        and(
          eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
          eq(polyTraderCurrentPositions.tokenId, "200099")
        )
      );
    expect(retained).toMatchObject({
      shares: "10.00000000",
      currentValueUsdc: "5.00000000",
      lastObservedAt: new Date("2026-10-03T19:00:00Z"),
    });
  });

  it("records budget recovery for a zero-capacity terminal sentinel without a fifty-first call", async () => {
    const wallet = await seedWallet("5404");
    const db = getSeedDb();
    const rows = Array.from({ length: 5_000 }, (_, i) => ({
      traderWalletId: wallet.id,
      conditionId: "open-budget",
      tokenId: String(300_000 + i),
      shares: "10",
      costBasisUsdc: "4",
      currentValueUsdc: "5",
      avgPrice: "0.4",
      contentHash: `open-${i}`,
      lastObservedAt: new Date("2026-10-03T19:00:00Z"),
    }));
    for (let i = 0; i < rows.length; i += 500)
      await db
        .insert(polyTraderCurrentPositions)
        .values(rows.slice(i, i + 500));
    await seedCurrent(wallet.id, "54041");
    await db
      .update(polyTraderCurrentPositions)
      .set({ active: false })
      .where(
        and(
          eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
          eq(polyTraderCurrentPositions.tokenId, "54041")
        )
      );
    const calls = vi.fn(async ({ tokenIds }: { tokenIds: readonly string[] }) =>
      tokenIds.map(() => 0n)
    );
    expect(
      (
        await refreshCurrentPositionsForWallet({
          db: db as unknown as WriterDb,
          walletAddress: wallet.address,
          client: clientReturning(async () => [position("54042")]),
          readPositionBalances: calls,
        })
      ).complete
    ).toBe(true);
    expect(calls).toHaveBeenCalledTimes(50);
    expect(
      calls.mock.calls.every(([input]) => !input.tokenIds.includes("54041"))
    ).toBe(true);
    const cursor = await positionCursor(wallet.id);
    expect(cursor.status).toBe("ok");
    expect(cursor.errorMessage).toBe(
      'terminal_recovery_v1:{"reason":"authority_budget","anchor":null}'
    );
    expect(cursor.lastSeenNativeId).toBeNull();
  });

  it("retains short recovery when a later time-budget failure follows crossing the old anchor", async () => {
    const wallet = await seedWallet("5405");
    const db = getSeedDb();
    const rows = Array.from({ length: 201 }, (_, i) => ({
      traderWalletId: wallet.id,
      conditionId: "timed-terminal",
      tokenId: String(400_000 + i),
      active: false,
      shares: "10",
      costBasisUsdc: "4",
      currentValueUsdc: "5",
      avgPrice: "0.4",
      contentHash: `timed-${i}`,
      lastObservedAt: new Date("2026-10-03T19:00:00Z"),
    }));
    await db.insert(polyTraderCurrentPositions).values(rows);
    await db
      .update(polyTraderIngestionCursors)
      .set({
        lastSeenNativeId: '["timed-terminal","400200"]',
        errorMessage:
          'terminal_recovery_v1:{"reason":"authority_unavailable","anchor":["timed-terminal","400000"]}',
      })
      .where(
        and(
          eq(polyTraderIngestionCursors.traderWalletId, wallet.id),
          eq(polyTraderIngestionCursors.source, "data-api-positions")
        )
      );
    let now = Date.now() + 60_000;
    const authority = vi.fn(
      async ({ tokenIds }: { tokenIds: readonly string[] }) => {
        now += 30_001;
        return tokenIds.map(() => 1n);
      }
    );
    const result = await refreshWithProductionControl({
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client: clientReturning(async () => [position("54052")]),
      readPositionBalances: authority,
      positionControl: new PositionObservationController({ now: () => now }),
    });
    expect(result.complete).toBe(true);
    expect(authority).toHaveBeenCalledTimes(1);
    const cursor = await positionCursor(wallet.id);
    expect(cursor.status).toBe("ok");
    expect(cursor.errorMessage).toBe(
      'terminal_recovery_v1:{"reason":"authority_budget","anchor":["timed-terminal","400099"]}'
    );
    expect(cursor.lastErrorAt).toEqual(cursor.updatedAt);
    const retained = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(
        and(
          eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
          eq(polyTraderCurrentPositions.tokenId, "400100")
        )
      );
    expect(retained[0]).toMatchObject({
      shares: "10.00000000",
      lastObservedAt: new Date("2026-10-03T19:00:00Z"),
    });
  });

  it("rolls back terminal zero, lifecycle changes, healthy rows and fairness cursor together", async () => {
    const wallet = await seedWallet("5204");
    const db = getSeedDb();
    await seedCurrent(wallet.id, "9301");
    await db
      .update(polyTraderCurrentPositions)
      .set({ raw: { redeemable: true } })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const [before] = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    await expect(
      refreshCurrentPositionsForWallet({
        db: db as unknown as WriterDb,
        walletAddress: wallet.address,
        client: clientReturning(async () => [position("9302")]),
        readPositionBalances: async () => [0n],
        beforePositionCursorPublish: () => {
          throw new Error("terminal cursor rollback");
        },
      })
    ).rejects.toThrow("terminal cursor rollback");
    const current = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(current).toEqual([before]);
    const [cursor] = await db
      .select()
      .from(polyTraderIngestionCursors)
      .where(eq(polyTraderIngestionCursors.traderWalletId, wallet.id));
    expect(cursor?.lastSuccessAt).toEqual(wallet.lastSuccessAt);
    expect(cursor?.lastSeenNativeId).toBeNull();
  });

  it("aborts terminal authority without publishing healthy rows or changing retained timestamps", async () => {
    const wallet = await seedWallet("5205");
    const db = getSeedDb();
    await seedCurrent(wallet.id, "9401");
    await seedLoser("9401");
    const controller = new AbortController();
    await expect(
      refreshCurrentPositionsForWallet({
        db: db as unknown as WriterDb,
        walletAddress: wallet.address,
        client: clientReturning(async () => [position("9402")]),
        signal: controller.signal,
        readPositionBalances: async () => {
          controller.abort(new Error("terminal caller aborted"));
          throw controller.signal.reason;
        },
      })
    ).rejects.toThrow("terminal caller aborted");
    const rows = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      active: true,
      shares: "10.00000000",
      lastObservedAt: new Date("2026-10-03T19:00:00.000Z"),
    });
  });

  it("rechecks a terminal quantity race before applying old zero proof", async () => {
    const wallet = await seedWallet("5206");
    const db = getSeedDb();
    await seedCurrent(wallet.id, "9501");
    await db
      .update(polyTraderCurrentPositions)
      .set({ active: false })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    let calls = 0;
    const result = await refreshCurrentPositionsForWallet({
      db: db as unknown as WriterDb,
      walletAddress: wallet.address,
      client: clientReturning(async () => [position("9502")]),
      readPositionBalances: async () => {
        calls += 1;
        if (calls === 1) {
          await db
            .update(polyTraderCurrentPositions)
            .set({ shares: "35" })
            .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
          return [0n];
        }
        return [35_000_000n];
      },
    });
    expect(result.complete).toBe(true);
    expect(calls).toBe(2);
    const [retained] = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(
        and(
          eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
          eq(polyTraderCurrentPositions.tokenId, "9501")
        )
      );
    expect(retained).toMatchObject({
      active: false,
      shares: "35.00000000",
      lastObservedAt: new Date("2026-10-03T19:00:00.000Z"),
    });
  });

  it("shares fifty chunks across open and terminal cohorts and rotates beyond one tick's budget", async () => {
    const wallet = await seedWallet("5207");
    const db = getSeedDb();
    await seedCurrent(wallet.id, "9600"); // blocking active omission goes first
    const rows = Array.from({ length: 5_001 }, (_, i) => ({
      traderWalletId: wallet.id,
      conditionId: "condition-terminal-budget",
      tokenId: String(100_000 + i),
      active: false,
      shares: "10",
      costBasisUsdc: "4",
      currentValueUsdc: "5",
      avgPrice: "0.4",
      contentHash: `terminal-budget-${i}`,
      lastObservedAt: new Date("2026-10-03T19:00:00Z"),
    }));
    for (let i = 0; i < rows.length; i += 500) {
      await db
        .insert(polyTraderCurrentPositions)
        .values(rows.slice(i, i + 500));
    }
    const chunks: string[][] = [];
    const refresh = () =>
      refreshCurrentPositionsForWallet({
        db: db as unknown as WriterDb,
        walletAddress: wallet.address,
        client: clientReturning(async () => [position("9601")]),
        readPositionBalances: async ({ tokenIds }) => {
          chunks.push([...tokenIds]);
          return tokenIds.map((id) => (id === "9600" ? 0n : 1n));
        },
      });
    expect((await refresh()).complete).toBe(true);
    expect(chunks).toHaveLength(50);
    expect(chunks[0]).toEqual(["9600"]);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBe(100);
    const firstChecked = new Set(chunks.flat());
    chunks.length = 0;
    expect((await refresh()).complete).toBe(true);
    expect(chunks).toHaveLength(50);
    // The next generation starts at the remaining terminal tokens, rather
    // than rechecking the first 4,900 indefinitely. Same condition tests the
    // token half of the durable keyset, not merely condition ordering.
    expect(chunks[0]?.every((id) => !firstChecked.has(id))).toBe(true);
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
    expect(logger.info.mock.calls.some(([payload]) =>
      payload.event === "poly.trader.positions.publish" && payload.published === true
    )).toBe(false);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: "poly.trader.positions.settled_after_abort"
    }), expect.any(String));
  });

  it("preserves trusted recovery proof while replacing inventory and ignores vendor-supplied reserved keys", async () => {
    const wallet = await seedWallet("5112");
    await seedCurrent(wallet.id, "801");
    const db = getSeedDb();
    const economicObservationV1 = {
      version: 1,
      fetchedAt: "2026-10-03T18:00:00.000Z",
      source: "test-recovery",
    };
    await db
      .update(polyTraderCurrentPositions)
      .set({
        raw: {
          ...position("801"),
          curPrice: 0.9,
          staleVendorField: "must not survive",
          economicObservationV1,
        },
      })
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));

    const incoming = ["801", "802"].map((tokenId) => ({
      ...position(tokenId),
      economicObservationV1: { source: "untrusted-vendor" },
    }));
    const published = await refreshCurrentPositionsForWallet({
      db: db as unknown as WriterDb,
      client: clientReturning(async () => incoming),
      walletAddress: wallet.address,
      readPositionBalances: async () => [],
    });
    expect(published.complete).toBe(true);

    const current = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(eq(polyTraderCurrentPositions.traderWalletId, wallet.id));
    const existing = current.find((row) => row.tokenId === "801");
    const inserted = current.find((row) => row.tokenId === "802");
    expect(existing).toMatchObject({
      active: true,
      shares: "10.00000000",
      currentValueUsdc: "5.00000000",
    });
    expect(existing?.raw).toMatchObject({
      curPrice: 0.5,
      economicObservationV1,
    });
    expect(existing?.raw).not.toHaveProperty("staleVendorField");
    expect(inserted?.raw).not.toHaveProperty("economicObservationV1");
    const snapshots = await db
      .select()
      .from(polyTraderPositionSnapshots)
      .where(eq(polyTraderPositionSnapshots.traderWalletId, wallet.id));
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.raw).not.toHaveProperty("economicObservationV1");
    }

    // A later exact-zero authority publication retains historical proof but
    // never retains the prior held quantity as inventory authority.
    const zeroed = await refreshCurrentPositionsForWallet({
      db: db as unknown as WriterDb,
      client: clientReturning(async () => []),
      walletAddress: wallet.address,
      readPositionBalances: async ({ tokenIds }) => tokenIds.map(() => 0n),
    });
    expect(zeroed.complete).toBe(true);
    const [closed] = await db
      .select()
      .from(polyTraderCurrentPositions)
      .where(
        and(
          eq(polyTraderCurrentPositions.traderWalletId, wallet.id),
          eq(polyTraderCurrentPositions.tokenId, "801")
        )
      );
    expect(closed).toMatchObject({
      active: false,
      shares: "0.00000000",
      currentValueUsdc: "0.00000000",
    });
    expect(closed?.raw).toMatchObject({ economicObservationV1 });
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
