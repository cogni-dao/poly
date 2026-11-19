// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/component/db/trader-pnl-read`
 * Purpose: Prove the one-statement Trader P/L overlay read (bug.5065) against real Postgres:
 *   every requested wallet comes back, every interval is bounded server-side, the last point
 *   per bucket wins, and unobserved / empty / stale wallets carry warnings instead of vanishing.
 * Scope: Seeds synthetic wallets + `poly_trader_user_pnl_points` rows into the testcontainers
 *   Postgres and calls `getTraderPnl` with a pinned clock.
 * Invariants under test: NEVER_SILENTLY_DROP, SERVER_DOWNSAMPLED, ONE_STATEMENT_ONE_CONNECTION,
 *   INTERVAL_MAP_SHARED (trader-pnl-service docstring).
 * Side-effects: IO (test database seed + cleanup)
 * Links: src/features/wallet-analysis/server/trader-pnl-service.ts, work/items/bug.5065
 * @public
 */

import {
  PolyResearchTraderPnlResponseSchema,
  TRADER_PNL_MAX_POINTS,
} from "@cogni/poly-node-contracts";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getTraderPnl } from "@/features/wallet-analysis/server/trader-pnl-service";
import { polyTraderUserPnlPoints, polyTraderWallets } from "@/shared/db/schema";

type ServiceDb = Parameters<typeof getTraderPnl>[0];

const NOW = new Date("2026-06-15T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FRESH_OBSERVED_AT = new Date(NOW.getTime() - 60_000);

// Unique per-run addresses so concurrent suites never collide on the unique wallet index.
const SUFFIX = Date.now().toString(16).padStart(8, "0").slice(-8);
const addr = (n: number): `0x${string}` =>
  `0x${`b5065${SUFFIX}`.padEnd(39, "0")}${n}`;

const seededWalletIds: string[] = [];

async function seedWallet(
  address: string,
  label: string,
  opts: { disabled?: boolean } = {}
): Promise<string> {
  const db = getSeedDb();
  const inserted = await db
    .insert(polyTraderWallets)
    .values({
      walletAddress: address,
      kind: "copy_target",
      label,
      ...(opts.disabled ? { disabledAt: NOW } : {}),
    })
    .returning({ id: polyTraderWallets.id });
  const id = inserted[0]?.id;
  if (!id) throw new Error("failed to seed wallet");
  seededWalletIds.push(id);
  return id;
}

async function seedPoints(
  walletId: string,
  fidelity: "1h" | "1d",
  points: { ts: Date; pnl: number }[],
  observedAt: Date = FRESH_OBSERVED_AT
): Promise<void> {
  const db = getSeedDb();
  for (let i = 0; i < points.length; i += 500) {
    await db.insert(polyTraderUserPnlPoints).values(
      points.slice(i, i + 500).map((p) => ({
        traderWalletId: walletId,
        fidelity,
        ts: p.ts,
        pnlUsdc: p.pnl.toFixed(8),
        observedAt,
      }))
    );
  }
}

/** n points ending at (and including) `end`, spaced `stepMs`, pnl = index (monotonic). */
function series(
  n: number,
  stepMs: number,
  end: Date
): { ts: Date; pnl: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(end.getTime() - (n - 1 - i) * stepMs),
    pnl: i,
  }));
}

describe("getTraderPnl (bug.5065) — real Postgres", () => {
  afterAll(async () => {
    if (seededWalletIds.length === 0) return;
    const db = getSeedDb();
    await db
      .delete(polyTraderUserPnlPoints)
      .where(inArray(polyTraderUserPnlPoints.traderWalletId, seededWalletIds));
    await db
      .delete(polyTraderWallets)
      .where(inArray(polyTraderWallets.id, seededWalletIds));
  });

  it("returns all three wallets for 1W / 1M / ALL, bounded, with the latest value last", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const hourlyEnd = new Date(Math.floor(NOW.getTime() / HOUR) * HOUR);
    const dailyEnd = new Date(Math.floor(NOW.getTime() / DAY) * DAY);
    const wallets = [addr(1), addr(2), addr(3)];
    for (const [i, address] of wallets.entries()) {
      const id = await seedWallet(address, `pnl-${i}`);
      // 35d hourly (retention window) + 600d daily + 4 off-grid noisy rows/day for the last 30d
      // (prod RN1 stored ~507 `1d` rows in 30d).
      await seedPoints(id, "1h", series(35 * 24, HOUR, hourlyEnd));
      await seedPoints(id, "1d", series(600, DAY, dailyEnd));
      const noise = Array.from({ length: 4 * 30 }, (_, k) => ({
        ts: new Date(dailyEnd.getTime() - (k + 1) * 6 * HOUR + 17_000),
        pnl: 10_000 + k,
      }));
      await seedPoints(id, "1d", noise);
    }

    for (const interval of ["1D", "1W", "1M", "1Y", "YTD", "ALL"] as const) {
      const res = await getTraderPnl(
        db,
        wallets.map((address) => ({ address })),
        interval,
        { now: NOW }
      );
      expect(PolyResearchTraderPnlResponseSchema.safeParse(res).success).toBe(
        true
      );
      expect(res.warnings).toEqual([]);
      expect(res.traders.map((t) => t.address)).toEqual(wallets);
      for (const trader of res.traders) {
        expect(trader.pnl.history.length).toBeGreaterThan(1);
        expect(trader.pnl.history.length).toBeLessThanOrEqual(
          TRADER_PNL_MAX_POINTS
        );
        const stamps = trader.pnl.history.map((p) => p.ts);
        expect([...stamps].sort()).toEqual(stamps);
        expect(new Set(stamps).size).toBe(stamps.length);
      }
      // Wallets share the same bucket grid, so the overlay rows align on ts.
      const first = res.traders[0]?.pnl.history.map((p) => p.ts);
      for (const trader of res.traders) {
        expect(trader.pnl.history.map((p) => p.ts)).toEqual(first);
      }
    }

    // 1W = hourly rows untouched: 168 hours + the boundary hour at most.
    const week = await getTraderPnl(db, [{ address: wallets[0] as string }], "1W", {
      now: NOW,
    });
    expect(week.traders[0]?.pnl.history.length).toBeGreaterThanOrEqual(168);
    expect(week.traders[0]?.pnl.history.length).toBeLessThanOrEqual(169);

    // 1M over the noisy 1d rows collapses to ONE point per day (<= 31), last-in-bucket wins.
    const month = await getTraderPnl(db, [{ address: wallets[0] as string }], "1M", {
      now: NOW,
    });
    const monthPts = month.traders[0]?.pnl.history ?? [];
    expect(monthPts.length).toBeLessThanOrEqual(31);
    const days = monthPts.map((p) => p.ts.slice(0, 10));
    expect(new Set(days).size).toBe(days.length);

    // ALL spans the full 600d history (not an empty/short series) and stays bounded.
    const all = await getTraderPnl(db, [{ address: wallets[0] as string }], "ALL", {
      now: NOW,
    });
    const allPts = all.traders[0]?.pnl.history ?? [];
    const spanDays =
      (Date.parse(allPts.at(-1)?.ts ?? "") - Date.parse(allPts[0]?.ts ?? "")) /
      DAY;
    expect(spanDays).toBeGreaterThan(550);
    expect(allPts.length).toBeLessThanOrEqual(TRADER_PNL_MAX_POINTS);
  });

  it("never silently drops: unobserved, disabled, no-history, and stale wallets carry warnings", async () => {
    const db = getSeedDb() as unknown as ServiceDb;
    const hourlyEnd = new Date(Math.floor(NOW.getTime() / HOUR) * HOUR);
    const okAddr = addr(4);
    const staleAddr = addr(5);
    const noHistoryAddr = addr(6);
    const disabledAddr = addr(7);
    const unknownAddr = addr(8);

    await seedPoints(await seedWallet(okAddr, "ok"), "1h", series(48, HOUR, hourlyEnd));
    await seedPoints(
      await seedWallet(staleAddr, "stale"),
      "1h",
      series(48, HOUR, hourlyEnd),
      new Date(NOW.getTime() - 60 * 60_000)
    );
    await seedWallet(noHistoryAddr, "empty");
    await seedPoints(
      await seedWallet(disabledAddr, "disabled", { disabled: true }),
      "1h",
      series(48, HOUR, hourlyEnd)
    );

    const requested = [okAddr, staleAddr, noHistoryAddr];
    const res = await getTraderPnl(
      db,
      requested.map((address) => ({ address })),
      "1W",
      { now: NOW }
    );
    expect(res.traders.map((t) => t.address)).toEqual(requested);
    const warnByWallet = new Map(res.warnings.map((w) => [w.wallet, w.code]));
    expect(warnByWallet.get(okAddr)).toBeUndefined();
    expect(warnByWallet.get(staleAddr)).toBe("pnl_history_stale");
    expect(warnByWallet.get(noHistoryAddr)).toBe("pnl_history_not_recorded");
    // Stale points are still served alongside the warning.
    expect(res.traders[1]?.pnl.history.length).toBe(48);
    expect(res.traders[2]?.pnl.history).toEqual([]);

    const res2 = await getTraderPnl(
      db,
      [{ address: disabledAddr }, { address: unknownAddr, label: "Ghost" }],
      "1W",
      { now: NOW }
    );
    expect(res2.traders.map((t) => t.label)).toEqual([
      disabledAddr.slice(0, 6) + "..." + disabledAddr.slice(-4),
      "Ghost",
    ]);
    expect(res2.warnings.map((w) => w.code)).toEqual([
      "wallet_not_observed",
      "wallet_not_observed",
    ]);
  });
});
