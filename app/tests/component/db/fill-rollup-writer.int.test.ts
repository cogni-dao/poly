// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/fill-rollup-writer`
 * Purpose: Behavior proofs for the incremental fill-rollup accumulator
 *   (task.research-rollup-read-models): idempotency (same window twice never
 *   double-counts), multi-batch == single-batch equivalence, backfill-then-
 *   incremental == backfill-all equivalence, UTC-day bucketing at midnight
 *   boundaries, and watermark advancement.
 * Scope: Real testcontainers Postgres via the seed client. No Polymarket IO.
 * Invariants:
 *   - Rollup contents are compared against a direct GROUP BY over the seeded
 *     fills — the fills table is the source of truth.
 * Side-effects: IO (test database seed + cleanup)
 * Links: src/features/wallet-analysis/server/fill-rollup-service.ts
 * @public
 */

import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  polyTraderFills,
  polyTraderWallets,
} from "@/shared/db/schema";
import {
  accumulateFillRollups,
  backfillFillRollups,
} from "@/features/wallet-analysis/server/fill-rollup-service";

type ServiceDb = Parameters<typeof accumulateFillRollups>[0];

const seededWalletIds: string[] = [];

async function seedWallet(label: string): Promise<string> {
  const db = getSeedDb();
  const address = `0x${(seededWalletIds.length + 0xa1)
    .toString(16)
    .padStart(4, "0")
    .repeat(10)}`.slice(0, 42);
  const inserted = await db
    .insert(polyTraderWallets)
    .values({ walletAddress: address, kind: "copy_target", label })
    .returning({ id: polyTraderWallets.id });
  const id = inserted[0]?.id;
  if (!id) throw new Error("failed to seed wallet");
  seededWalletIds.push(id);
  return id;
}

type FillSeed = {
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  sizeUsdc: number;
  observedAt: string;
};

async function seedFills(
  walletId: string,
  fills: readonly FillSeed[],
  idPrefix: string
): Promise<void> {
  if (fills.length === 0) return;
  const db = getSeedDb();
  await db.insert(polyTraderFills).values(
    fills.map((f, i) => ({
      traderWalletId: walletId,
      source: "data-api" as const,
      nativeId: `${idPrefix}-${i}`,
      conditionId: f.conditionId,
      tokenId: f.tokenId,
      side: f.side,
      price: "0.5",
      shares: String(f.sizeUsdc * 2),
      sizeUsdc: String(f.sizeUsdc),
      observedAt: new Date(f.observedAt),
    }))
  );
}

/** Direct GROUP BY over fills — the ground truth the rollup must reproduce. */
async function truthFromFills(
  walletId: string
): Promise<Array<Record<string, unknown>>> {
  const db = getSeedDb();
  const rows = (await db.execute(sql`
    SELECT
      f.condition_id, f.token_id,
      (f.observed_at AT TIME ZONE 'UTC')::date::text AS day,
      COUNT(*)::int AS fill_count,
      COUNT(*) FILTER (WHERE f.side = 'BUY')::int AS buy_count,
      COUNT(*) FILTER (WHERE f.side = 'SELL')::int AS sell_count,
      COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'BUY'), 0)::float8 AS buy_usdc,
      COALESCE(SUM(f.size_usdc) FILTER (WHERE f.side = 'SELL'), 0)::float8 AS sell_usdc,
      COALESCE(SUM(f.shares) FILTER (WHERE f.side = 'BUY'), 0)::float8 AS buy_shares,
      COALESCE(SUM(f.shares) FILTER (WHERE f.side = 'SELL'), 0)::float8 AS sell_shares,
      MIN(f.observed_at) FILTER (WHERE f.side = 'BUY') AS first_buy_observed_at,
      MIN(f.observed_at) AS first_observed_at,
      MAX(f.observed_at) AS last_observed_at
    FROM poly_trader_fills f
    WHERE f.trader_wallet_id = ${walletId}::uuid
    GROUP BY 1, 2, 3
    ORDER BY 1, 2, 3
  `)) as unknown as Array<Record<string, unknown>>;
  return Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
}

async function rollupRows(
  walletId: string
): Promise<Array<Record<string, unknown>>> {
  const db = getSeedDb();
  const rows = (await db.execute(sql`
    SELECT
      r.condition_id, r.token_id, r.day::text AS day,
      r.fill_count, r.buy_count, r.sell_count,
      r.buy_usdc::float8 AS buy_usdc, r.sell_usdc::float8 AS sell_usdc,
      r.buy_shares::float8 AS buy_shares, r.sell_shares::float8 AS sell_shares,
      r.first_buy_observed_at, r.first_observed_at, r.last_observed_at
    FROM poly_trader_fill_rollups_daily r
    WHERE r.trader_wallet_id = ${walletId}::uuid
    ORDER BY r.condition_id, r.token_id, r.day
  `)) as unknown as Array<Record<string, unknown>>;
  const list = Array.isArray(rows)
    ? rows
    : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
  // Strip the wallet-independent comparison shape (truth query has no wallet col).
  return list;
}

function stripKeys(
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const { condition_id, token_id, day, ...rest } = r;
    return {
      condition_id,
      token_id,
      day,
      ...Object.fromEntries(
        Object.entries(rest).map(([k, v]) => [
          k,
          v instanceof Date ? v.toISOString() : v,
        ])
      ),
    };
  });
}

/** A fixture spanning UTC-midnight boundaries, both sides, multiple markets. */
function boundaryFills(midnightIso: string): FillSeed[] {
  const m = Date.parse(midnightIso);
  const at = (offsetMs: number): string => new Date(m + offsetMs).toISOString();
  return [
    { conditionId: "cw1", tokenId: "tw1a", side: "BUY", sizeUsdc: 1.25, observedAt: at(-1) },
    { conditionId: "cw1", tokenId: "tw1a", side: "BUY", sizeUsdc: 2.5, observedAt: at(0) },
    { conditionId: "cw1", tokenId: "tw1a", side: "SELL", sizeUsdc: 0.75, observedAt: at(3_600_000) },
    { conditionId: "cw1", tokenId: "tw1b", side: "SELL", sizeUsdc: 4, observedAt: at(7_200_000) },
    { conditionId: "cw2", tokenId: "tw2a", side: "BUY", sizeUsdc: 10, observedAt: at(-86_400_000) },
    { conditionId: "cw2", tokenId: "tw2a", side: "BUY", sizeUsdc: 5.25, observedAt: at(86_400_000 + 1) },
    { conditionId: "cw2", tokenId: "tw2b", side: "BUY", sizeUsdc: 0.25, observedAt: at(2 * 86_400_000) },
  ];
}

/** UTC midnight ~20 days ago, so all fixture fills predate "now". */
function anchorMidnightIso(): string {
  const nowDay = new Date();
  const m = Date.UTC(
    nowDay.getUTCFullYear(),
    nowDay.getUTCMonth(),
    nowDay.getUTCDate() - 20
  );
  return new Date(m).toISOString();
}

describe("fill-rollup accumulator (task.research-rollup-read-models)", () => {
  afterAll(async () => {
    const db = getSeedDb();
    if (seededWalletIds.length > 0) {
      // Rollups + cursors cascade on wallet delete (FK ON DELETE CASCADE).
      await db
        .delete(polyTraderFills)
        .where(inArray(polyTraderFills.traderWalletId, seededWalletIds));
      await db
        .delete(polyTraderWallets)
        .where(inArray(polyTraderWallets.id, seededWalletIds));
    }
  });

  it("accumulate reproduces the direct GROUP BY, incl. UTC-day boundary fills", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const walletId = await seedWallet("writer-truth");
    await seedFills(walletId, boundaryFills(anchorMidnightIso()), "wt");

    const result = await accumulateFillRollups(db, { traderWalletId: walletId });
    expect(result.caughtUp).toBe(true);
    expect(result.fills).toBe(7);

    expect(stripKeys(await rollupRows(walletId))).toEqual(
      stripKeys(await truthFromFills(walletId))
    );
  });

  it("is idempotent: re-running with no new fills changes nothing", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const walletId = await seedWallet("writer-idem");
    await seedFills(walletId, boundaryFills(anchorMidnightIso()), "wi");

    const first = await accumulateFillRollups(db, { traderWalletId: walletId });
    expect(first.fills).toBe(7);
    const snapshot = stripKeys(await rollupRows(walletId));

    const second = await accumulateFillRollups(db, { traderWalletId: walletId });
    expect(second.fills).toBe(0);
    expect(second.caughtUp).toBe(true);
    expect(stripKeys(await rollupRows(walletId))).toEqual(snapshot);
  });

  it("multi-batch accumulate equals single-batch accumulate", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const batchedWallet = await seedWallet("writer-batched");
    const singleWallet = await seedWallet("writer-single");
    const fills = boundaryFills(anchorMidnightIso());
    await seedFills(batchedWallet, fills, "wb");
    await seedFills(singleWallet, fills, "ws");

    const batched = await accumulateFillRollups(db, {
      traderWalletId: batchedWallet,
      batchSize: 2,
    });
    expect(batched.fills).toBe(7);
    expect(batched.batches).toBe(4);
    const single = await accumulateFillRollups(db, {
      traderWalletId: singleWallet,
    });
    expect(single.batches).toBe(1);

    expect(stripKeys(await rollupRows(batchedWallet))).toEqual(
      stripKeys(await rollupRows(singleWallet))
    );
  });

  it("backfill-half + incremental ticks equals backfill-all", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const stagedWallet = await seedWallet("writer-staged");
    const allAtOnceWallet = await seedWallet("writer-allatonce");
    const fills = boundaryFills(anchorMidnightIso());
    const firstHalf = fills.slice(0, 4);
    const secondHalf = fills.slice(4);

    // Staged: half the history, backfill, then "the tick" ingests the rest.
    await seedFills(stagedWallet, firstHalf, "wh-a");
    await accumulateFillRollups(db, { traderWalletId: stagedWallet, batchSize: 3 });
    await seedFills(stagedWallet, secondHalf, "wh-b");
    await accumulateFillRollups(db, { traderWalletId: stagedWallet, batchSize: 3 });

    // Control: everything present before a single backfill pass.
    await seedFills(allAtOnceWallet, fills, "wa");
    await accumulateFillRollups(db, { traderWalletId: allAtOnceWallet });

    expect(stripKeys(await rollupRows(stagedWallet))).toEqual(
      stripKeys(await rollupRows(allAtOnceWallet))
    );
    expect(stripKeys(await rollupRows(stagedWallet))).toEqual(
      stripKeys(await truthFromFills(stagedWallet))
    );
  });

  it("maxBatches bounds one pass and the next pass resumes at the watermark", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const walletId = await seedWallet("writer-resume");
    await seedFills(walletId, boundaryFills(anchorMidnightIso()), "wr");

    const bounded = await accumulateFillRollups(db, {
      traderWalletId: walletId,
      batchSize: 3,
      maxBatches: 1,
    });
    expect(bounded.fills).toBe(3);
    expect(bounded.caughtUp).toBe(false);

    const rest = await accumulateFillRollups(db, {
      traderWalletId: walletId,
      batchSize: 3,
    });
    expect(rest.fills).toBe(4);
    expect(rest.caughtUp).toBe(true);
    expect(stripKeys(await rollupRows(walletId))).toEqual(
      stripKeys(await truthFromFills(walletId))
    );
  });

  it("backfillFillRollups walks every wallet to caught-up", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const walletId = await seedWallet("writer-walker");
    await seedFills(walletId, boundaryFills(anchorMidnightIso()), "ww");

    const noopLogger = {
      child: () => noopLogger,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as unknown as Parameters<typeof backfillFillRollups>[1]["logger"];

    const result = await backfillFillRollups(db, { logger: noopLogger });
    expect(result.completed).toBe(true);
    expect(stripKeys(await rollupRows(walletId))).toEqual(
      stripKeys(await truthFromFills(walletId))
    );
  });
});
