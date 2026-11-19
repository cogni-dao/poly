// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/trader-pnl-service`
 * Purpose: Prove the pure halves of the Trader P/L overlay read (bug.5065): the per-interval
 *   mapping (stored series, window, bucket floor) and the no-silent-drop assembly rule.
 * Scope: Unit — no Db. The SQL itself is proven against Postgres in
 *   `tests/component/db/trader-pnl-read.int.test.ts`.
 * Invariants under test: INTERVAL_MAP_SHARED, NEVER_SILENTLY_DROP, BOUNDED_POINTS
 *   (trader-pnl-service docstring).
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/trader-pnl-service.ts, work/items/bug.5065
 * @internal
 */

import {
  PolyResearchTraderPnlResponseSchema,
  type PolyWalletOverviewInterval,
} from "@cogni/poly-node-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  assembleTraderPnl,
  buildTraderPnlStatement,
  planTraderPnlRead,
  TRADER_PNL_NO_HISTORY_WARNING,
  TRADER_PNL_NOT_OBSERVED_WARNING,
  TRADER_PNL_STALE_WARNING,
  type TraderPnlSqlRow,
} from "@/features/wallet-analysis/server/trader-pnl-service";

const RN1 = "0x2005d16a84ceefa912d4e380cd32e7ff827875ea";
const SWISSTONY = "0x204f72f35326db932158cba6adff0b9a1da95e14";
const CEO = "0x41a7ec25dc776bc364452c5c5cc936ffc6d5f296";

const NOW = "2026-11-19T01:30:00.000Z";
const NOW_MS = Date.parse(NOW);

describe("planTraderPnlRead — per-interval mapping", () => {
  it.each<
    [PolyWalletOverviewInterval, "1h" | "1d", string | null, number]
  >([
    ["1D", "1h", "2026-11-18T01:30:00.000Z", 3_600],
    ["1W", "1h", "2026-11-12T01:30:00.000Z", 3_600],
    ["1M", "1d", "2026-10-20T01:30:00.000Z", 86_400],
    ["1Y", "1d", "2025-11-19T01:30:00.000Z", 86_400],
    ["YTD", "1d", "2026-01-01T00:00:00.000Z", 86_400],
    ["ALL", "1d", null, 86_400],
  ])("%s -> %s rows, window %s, bucket floor %ss", (interval, fidelity, start, floor) => {
    expect(planTraderPnlRead(interval, NOW)).toEqual({
      fidelity,
      windowStartIso: start,
      minBucketSeconds: floor,
    });
  });
});

describe("buildTraderPnlStatement", () => {
  it("renders one parameterized statement bounded by the window, never selecting raw fills", () => {
    const stmt = new PgDialect().sqlToQuery(
      buildTraderPnlStatement(
        [RN1, SWISSTONY, CEO],
        planTraderPnlRead("1M", NOW),
        NOW
      )
    );
    expect(stmt.sql).toContain("poly_trader_user_pnl_points");
    expect(stmt.sql).not.toContain("poly_trader_fills");
    expect(stmt.sql).toContain("p.ts >=");
    expect(stmt.params).toEqual(
      expect.arrayContaining([RN1, SWISSTONY, CEO, "1d", 240])
    );
  });

  it("omits the lower bound for ALL", () => {
    const stmt = new PgDialect().sqlToQuery(
      buildTraderPnlStatement([RN1], planTraderPnlRead("ALL", NOW), NOW)
    );
    expect(stmt.sql).not.toContain("p.ts >=");
  });
});

function row(
  address: string,
  overrides: Partial<TraderPnlSqlRow> = {}
): TraderPnlSqlRow {
  return {
    wallet_address: address,
    label: "stored",
    observed_at: new Date(NOW_MS - 60_000),
    bucket_seconds: 3_600,
    bucket: Math.floor(NOW_MS / 3_600_000),
    pnl_usdc: "100.126",
    ...overrides,
  };
}

function points(address: string, n: number, observedAt?: Date): TraderPnlSqlRow[] {
  const end = Math.floor(NOW_MS / 3_600_000);
  return Array.from({ length: n }, (_, i) =>
    row(address, {
      bucket: end - (n - 1 - i),
      pnl_usdc: String(i * 10),
      ...(observedAt ? { observed_at: observedAt } : {}),
    })
  );
}

describe("assembleTraderPnl — never silently drops", () => {
  it("returns every requested wallet in request order, with labels re-stamped positionally", () => {
    const res = assembleTraderPnl(
      "1W",
      [
        { address: RN1.toUpperCase().replace("0X", "0x"), label: "RN1" },
        { address: SWISSTONY },
        { address: CEO, label: "You" },
      ],
      [...points(CEO, 3), ...points(RN1, 3), ...points(SWISSTONY, 3)],
      NOW
    );
    expect(res.traders.map((t) => t.address)).toEqual([RN1, SWISSTONY, CEO]);
    expect(res.traders.map((t) => t.label)).toEqual(["RN1", "stored", "You"]);
    expect(res.warnings).toEqual([]);
    expect(PolyResearchTraderPnlResponseSchema.safeParse(res).success).toBe(
      true
    );
  });

  it("converts bucket + width to an ISO ts and computes the windowed delta", () => {
    const res = assembleTraderPnl("1W", [{ address: RN1 }], points(RN1, 3), NOW);
    const trader = res.traders[0];
    expect(trader?.pnl.history.map((p) => p.pnl)).toEqual([0, 10, 20]);
    expect(trader?.pnl.history.at(-1)?.ts).toBe("2026-11-19T01:00:00.000Z");
    expect(trader?.pnl.usdc).toBe(20);
  });

  it("keeps an unobserved wallet with an empty series and a wallet_not_observed warning", () => {
    const res = assembleTraderPnl(
      "ALL",
      [{ address: RN1 }, { address: CEO, label: "You" }],
      points(RN1, 3),
      NOW
    );
    expect(res.traders).toHaveLength(2);
    const ceo = res.traders[1];
    expect(ceo).toMatchObject({
      address: CEO,
      label: "You",
      pnl: { usdc: null, history: [] },
    });
    expect(res.warnings).toEqual([
      expect.objectContaining({
        wallet: CEO,
        code: TRADER_PNL_NOT_OBSERVED_WARNING,
      }),
    ]);
  });

  it("flags an observed wallet with no points in the interval (pnl_history_not_recorded)", () => {
    const res = assembleTraderPnl(
      "1M",
      [{ address: CEO }],
      [row(CEO, { bucket: null, pnl_usdc: null, bucket_seconds: 86_400 })],
      NOW
    );
    expect(res.traders[0]?.pnl.history).toEqual([]);
    expect(res.warnings.map((w) => w.code)).toEqual([
      TRADER_PNL_NO_HISTORY_WARNING,
    ]);
  });

  it("serves stale points WITH a pnl_history_stale warning instead of dropping them", () => {
    const stale = new Date(NOW_MS - 30 * 60_000);
    const res = assembleTraderPnl(
      "1W",
      [{ address: RN1 }],
      points(RN1, 4, stale),
      NOW
    );
    expect(res.traders[0]?.pnl.history).toHaveLength(4);
    expect(res.warnings).toEqual([
      expect.objectContaining({ wallet: RN1, code: TRADER_PNL_STALE_WARNING }),
    ]);
  });

  it("collapses a duplicate requested wallet to one trader", () => {
    const res = assembleTraderPnl(
      "1W",
      [{ address: RN1 }, { address: RN1 }],
      points(RN1, 2),
      NOW
    );
    expect(res.traders).toHaveLength(1);
  });

  it("a single point has a null windowed delta (not 0)", () => {
    const res = assembleTraderPnl("1D", [{ address: RN1 }], points(RN1, 1), NOW);
    expect(res.traders[0]?.pnl.usdc).toBeNull();
  });
});
