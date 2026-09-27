// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/position-snapshot-retention.int.test`
 * Purpose: Prove the task.5012 snapshot retention pruner against a real
 *          Postgres — >35d rows are deleted, each (wallet, condition, token)
 *          group's newest row survives regardless of age, and deletes are
 *          bounded per batch.
 * Scope: DB-backed tests for `pruneOldPositionSnapshots`. Does not test the
 *        observation tick, routes, or RLS.
 * Invariants:
 *   - WINDOW_PRUNED: rows older than 35 days with a newer sibling in their
 *     group are deleted.
 *   - LATEST_ROW_IMMORTAL: the newest row per (trader_wallet_id,
 *     condition_id, token_id) is never deleted, however old — it is the
 *     durable record `readTargetLegs` reads for exited/unchanged positions.
 *   - BATCH_BOUNDED: each DELETE statement removes at most `batchSize` rows
 *     and a call stops after `maxBatches`, reporting `exhaustedBudget`.
 * Side-effects: IO (database operations via testcontainers)
 * Links: work/items/task.5012,
 *        src/features/wallet-analysis/server/trader-observation-service.ts
 * @public
 */

import {
  polyTraderPositionSnapshots,
  polyTraderWallets,
} from "@cogni/poly-db-schema/trader-activity";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pruneOldPositionSnapshots } from "@/features/wallet-analysis/server/trader-observation-service";

const WALLET_ADDR = `0x${"5012".repeat(10)}` as const;

const DAY_MS = 86_400_000;
const NOW = new Date();

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

let walletId: string;

function snapshot(input: {
  conditionId: string;
  tokenId: string;
  capturedAt: Date;
}) {
  return {
    traderWalletId: walletId,
    conditionId: input.conditionId,
    tokenId: input.tokenId,
    shares: "10.00000000",
    costBasisUsdc: "5.00000000",
    currentValueUsdc: "6.00000000",
    avgPrice: "0.50000000",
    contentHash: `hash-${input.conditionId}-${input.tokenId}-${input.capturedAt.getTime()}`,
    capturedAt: input.capturedAt,
    raw: { title: "retention test market" },
  };
}

async function survivingKeys(): Promise<string[]> {
  const db = getSeedDb();
  const rows = await db
    .select({
      conditionId: polyTraderPositionSnapshots.conditionId,
      tokenId: polyTraderPositionSnapshots.tokenId,
      capturedAt: polyTraderPositionSnapshots.capturedAt,
    })
    .from(polyTraderPositionSnapshots)
    .where(eq(polyTraderPositionSnapshots.traderWalletId, walletId));
  return rows
    .map(
      (r) =>
        `${r.conditionId}/${r.tokenId}@${Math.round(
          (NOW.getTime() - r.capturedAt.getTime()) / DAY_MS
        )}d`
    )
    .sort();
}

describe("poly_trader_position_snapshots retention (task.5012)", () => {
  const db = getSeedDb();

  beforeAll(async () => {
    const rows = await db
      .insert(polyTraderWallets)
      .values({
        walletAddress: WALLET_ADDR,
        kind: "copy_target",
        label: "retention-test",
      })
      .returning({ id: polyTraderWallets.id });
    const wallet = rows[0];
    if (!wallet) throw new Error("wallet seed insert returned no row");
    walletId = wallet.id;
  });

  afterAll(async () => {
    // FK cascade removes the snapshots.
    await db
      .delete(polyTraderWallets)
      .where(eq(polyTraderWallets.walletAddress, WALLET_ADDR));
  });

  it("prunes >35d rows but always keeps each group's newest row", async () => {
    await db.insert(polyTraderPositionSnapshots).values([
      // Group A: mark-churn history + a fresh row → only the fresh row stays.
      snapshot({ conditionId: "condA", tokenId: "tok1", capturedAt: daysAgo(60) }),
      snapshot({ conditionId: "condA", tokenId: "tok1", capturedAt: daysAgo(50) }),
      snapshot({ conditionId: "condA", tokenId: "tok1", capturedAt: daysAgo(40) }),
      snapshot({ conditionId: "condA", tokenId: "tok1", capturedAt: daysAgo(1) }),
      // Group B: exited long ago — single ancient row is the group's newest
      // and must survive (SNAPSHOTS_ARE_DURABLE_TRUTH).
      snapshot({ conditionId: "condB", tokenId: "tok2", capturedAt: daysAgo(90) }),
      // Group C: two ancient rows, nothing fresh → older deleted, newest kept.
      snapshot({ conditionId: "condC", tokenId: "tok3", capturedAt: daysAgo(60) }),
      snapshot({ conditionId: "condC", tokenId: "tok3", capturedAt: daysAgo(50) }),
      // Group D: inside the window → untouched.
      snapshot({ conditionId: "condD", tokenId: "tok4", capturedAt: daysAgo(10) }),
    ]);

    const result = await pruneOldPositionSnapshots(db);

    expect(result.deleted).toBe(4);
    expect(result.exhaustedBudget).toBe(false);
    expect(await survivingKeys()).toEqual([
      "condA/tok1@1d",
      "condB/tok2@90d",
      "condC/tok3@50d",
      "condD/tok4@10d",
    ]);

    // Idempotent: a second run finds nothing.
    const again = await pruneOldPositionSnapshots(db);
    expect(again.deleted).toBe(0);
  });

  it("bounds each delete to batchSize and stops after maxBatches", async () => {
    await db.insert(polyTraderPositionSnapshots).values(
      [80, 70, 60, 50, 2].map((days) =>
        snapshot({ conditionId: "condE", tokenId: "tok5", capturedAt: daysAgo(days) })
      )
    );

    const first = await pruneOldPositionSnapshots(db, {
      batchSize: 1,
      maxBatches: 2,
    });
    expect(first).toEqual({ deleted: 2, exhaustedBudget: true });

    const second = await pruneOldPositionSnapshots(db, {
      batchSize: 10,
      maxBatches: 5,
    });
    expect(second).toEqual({ deleted: 2, exhaustedBudget: false });

    expect(await survivingKeys()).toContain("condE/tok5@2d");
    expect(
      (await survivingKeys()).filter((k) => k.startsWith("condE/"))
    ).toEqual(["condE/tok5@2d"]);
  });
});
