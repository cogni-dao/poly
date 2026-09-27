// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/db/trader-comparison-sql-parity`
 * Purpose: Parity oracle for the bug.5008 SQL rewrite of the trader-comparison trade-size/P-L
 *   aggregation — proves the Postgres CTE pipeline reproduces the legacy JS reducer exactly.
 * Scope: Seeds synthetic wallets/fills/outcomes into the testcontainers Postgres, runs the new
 *   `readTradeSizePnl` SQL reader, and compares against the preserved JS oracle
 *   (`@tests/_fixtures/poly/trade-size-pnl-oracle`) over boundary-heavy fixtures.
 * Invariants:
 *   - ORACLE_IS_TRUTH: on mismatch, fix the SQL or the fixture — never the oracle.
 *   - Fixtures use dyadic decimals (multiples of 0.25) so float64 and numeric agree exactly
 *     at the 8-decimal rounding the contract applies.
 * Side-effects: IO (test database seed + cleanup)
 * Links: src/features/wallet-analysis/server/trader-comparison-service.ts, work/items/bug.5008
 * @public
 */

import { PolyResearchTraderSizePnlSchema } from "@cogni/poly-node-contracts";
import {
  buildTradeSizePnl,
  type OracleFill,
  type OracleOutcomeRow,
  resolutionsFromOutcomeRows,
} from "@tests/_fixtures/poly/trade-size-pnl-oracle";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  polyMarketOutcomes,
  polyTraderFills,
  polyTraderWallets,
} from "@/shared/db/schema";
import { readTradeSizePnl } from "@/features/wallet-analysis/server/trader-comparison-service";

type ServiceDb = Parameters<typeof readTradeSizePnl>[0];

/** Window start for every case: midnight UTC — a skill-mandated boundary value. */
const WINDOW_START_ISO = "2026-01-15T00:00:00.000Z";

type FixtureFill = {
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  shares: number;
  sizeUsdc: number;
  observedAt: string;
};

type FixtureCase = {
  name: string;
  fills: FixtureFill[];
  outcomes: OracleOutcomeRow[];
};

/** In-window timestamp helper (strictly after the window start unless offsetMs <= 0). */
function at(minutesAfterWindowStart: number): string {
  return new Date(
    Date.parse(WINDOW_START_ISO) + minutesAfterWindowStart * 60_000
  ).toISOString();
}

function buys(
  conditionId: string,
  tokenId: string,
  sizes: number[],
  startMinute: number
): FixtureFill[] {
  return sizes.map((sizeUsdc, i) => ({
    conditionId,
    tokenId,
    side: "BUY" as const,
    price: 0.5,
    shares: sizeUsdc * 2,
    sizeUsdc,
    observedAt: at(startMinute + i),
  }));
}

function mixedMediumCase(): FixtureCase {
  const conditions = ["c14a", "c14b", "c14c"];
  const tokens = [
    ["t14a1", "t14a2"],
    ["t14b1", "t14b2"],
    ["t14c1", "t14c2"],
  ];
  const fills: FixtureFill[] = [];
  for (let i = 0; i < 30; i += 1) {
    const cond = i % 3;
    const tok = tokens[cond]?.[i % 2];
    const condition = conditions[cond];
    if (!tok || !condition) throw new Error("fixture generator bug");
    fills.push({
      conditionId: condition,
      tokenId: tok,
      side: i % 5 === 4 ? "SELL" : "BUY",
      price: 0.5,
      shares: 0.5 * ((i % 7) + 1),
      sizeUsdc: 0.25 * (i + 1),
      // first 6 fills land BEFORE the window (full-history token P/L + hedge inputs)
      observedAt: at(i < 6 ? -60 + i : i),
    });
  }
  return {
    name: "mixed medium: 30 fills, 3 conditions, pre-window history, partial resolution",
    fills,
    outcomes: [
      { conditionId: "c14a", tokenId: "t14a1", outcome: "winner" },
      { conditionId: "c14a", tokenId: "t14a2", outcome: "loser" },
      // c14b: one unknown row -> condition not closed -> all its tokens pending
      { conditionId: "c14b", tokenId: "t14b1", outcome: "unknown" },
      { conditionId: "c14b", tokenId: "t14b2", outcome: "loser" },
      // c14c: no outcome rows at all -> pending
    ],
  };
}

const CASES: FixtureCase[] = [
  { name: "zero fills", fills: [], outcomes: [] },
  {
    name: "single unresolved buy",
    fills: buys("c02a", "t02a", [7.25], 60),
    outcomes: [],
  },
  {
    name: "single resolved winning buy",
    fills: [
      {
        conditionId: "c03a",
        tokenId: "t03y",
        side: "BUY",
        price: 0.5,
        shares: 10,
        sizeUsdc: 5,
        observedAt: at(60),
      },
    ],
    outcomes: [
      { conditionId: "c03a", tokenId: "t03y", outcome: "winner" },
      { conditionId: "c03a", tokenId: "t03n", outcome: "loser" },
    ],
  },
  {
    name: "window boundary: fill exactly at midnight-UTC window start; pre-window history in token P/L",
    fills: [
      {
        conditionId: "c04a",
        tokenId: "t04y",
        side: "BUY",
        price: 0.5,
        shares: 20,
        sizeUsdc: 10,
        observedAt: WINDOW_START_ISO, // >= boundary: included in buckets
      },
      {
        conditionId: "c04a",
        tokenId: "t04y",
        side: "BUY",
        price: 0.5,
        shares: 20,
        sizeUsdc: 10,
        observedAt: "2026-01-14T23:59:59.999Z", // 1ms before: excluded from buckets, in token P/L
      },
      {
        conditionId: "c04a",
        tokenId: "t04y",
        side: "SELL",
        price: 0.5,
        shares: 10,
        sizeUsdc: 5,
        observedAt: "2026-01-14T12:00:00.000Z",
      },
    ],
    outcomes: [
      { conditionId: "c04a", tokenId: "t04y", outcome: "winner" },
      { conditionId: "c04a", tokenId: "t04n", outcome: "loser" },
    ],
  },
  {
    name: "bucket edges: exactly 20 buys, one per bucket",
    fills: buys(
      "c05a",
      "t05a",
      Array.from({ length: 20 }, (_, i) => i + 1),
      10
    ),
    outcomes: [],
  },
  {
    name: "bucket remainder: 7 buys spread across sparse buckets",
    fills: buys(
      "c06a",
      "t06a",
      Array.from({ length: 7 }, (_, i) => 1.5 + i),
      10
    ),
    outcomes: [],
  },
  {
    name: "bucket remainder: 21 buys (first bucket takes two)",
    fills: buys(
      "c07a",
      "t07a",
      Array.from({ length: 21 }, (_, i) => i + 1),
      10
    ),
    outcomes: [],
  },
  {
    name: "size ties break by observed_at (resolved vs pending land in the right buckets)",
    fills: [
      {
        conditionId: "c08a",
        tokenId: "t08a",
        side: "BUY",
        price: 0.5,
        shares: 10,
        sizeUsdc: 5,
        observedAt: at(10),
      },
      {
        conditionId: "c08b",
        tokenId: "t08b",
        side: "BUY",
        price: 0.5,
        shares: 10,
        sizeUsdc: 5,
        observedAt: at(20),
      },
    ],
    outcomes: [
      { conditionId: "c08a", tokenId: "t08a", outcome: "winner" },
      { conditionId: "c08a", tokenId: "t08x", outcome: "loser" },
    ],
  },
  {
    name: "hedge classification: cheapest token of a multi-token condition (with pre-window cost)",
    fills: [
      // c09a: primary t09p (10 USDC) vs hedge t09h (2 pre-window + 1 in-window = 3 USDC)
      {
        conditionId: "c09a",
        tokenId: "t09h",
        side: "BUY",
        price: 0.5,
        shares: 4,
        sizeUsdc: 2,
        observedAt: at(-120),
      },
      {
        conditionId: "c09a",
        tokenId: "t09h",
        side: "BUY",
        price: 0.5,
        shares: 2,
        sizeUsdc: 1,
        observedAt: at(10),
      },
      {
        conditionId: "c09a",
        tokenId: "t09p",
        side: "BUY",
        price: 0.5,
        shares: 20,
        sizeUsdc: 10,
        observedAt: at(11),
      },
      // c09b: equal costs -> no hedge
      {
        conditionId: "c09b",
        tokenId: "t09c",
        side: "BUY",
        price: 0.5,
        shares: 10,
        sizeUsdc: 5,
        observedAt: at(12),
      },
      {
        conditionId: "c09b",
        tokenId: "t09d",
        side: "BUY",
        price: 0.5,
        shares: 10,
        sizeUsdc: 5,
        observedAt: at(13),
      },
    ],
    outcomes: [],
  },
  {
    name: "win/loss/flat thresholds at exactly +/-0.5 contribution",
    fills: (
      [
        ["c10a", "t10a", 21], // pnl +1    -> contribution 0.5  -> flat
        ["c10b", "t10b", 21.25], // pnl +1.25 -> contribution 0.625 -> win
        ["c10c", "t10c", 18.75], // pnl -1.25 -> contribution -0.625 -> loss
        ["c10d", "t10d", 19], // pnl -1    -> contribution -0.5 -> flat
      ] as const
    ).flatMap(([conditionId, tokenId, sellUsdc], i) => [
      {
        conditionId,
        tokenId,
        side: "BUY" as const,
        price: 0.5,
        shares: 5,
        sizeUsdc: 10,
        observedAt: at(-30 + i),
      },
      {
        conditionId,
        tokenId,
        side: "BUY" as const,
        price: 0.5,
        shares: 5,
        sizeUsdc: 10,
        observedAt: at(10 + i),
      },
      {
        conditionId,
        tokenId,
        side: "SELL" as const,
        price: 0.5,
        shares: 10,
        sizeUsdc: sellUsdc,
        observedAt: at(-20 + i),
      },
    ]),
    outcomes: [
      { conditionId: "c10a", tokenId: "t10a", outcome: "loser" },
      { conditionId: "c10a", tokenId: "t10ax", outcome: "winner" },
      { conditionId: "c10b", tokenId: "t10b", outcome: "loser" },
      { conditionId: "c10b", tokenId: "t10bx", outcome: "winner" },
      { conditionId: "c10c", tokenId: "t10c", outcome: "loser" },
      { conditionId: "c10c", tokenId: "t10cx", outcome: "winner" },
      { conditionId: "c10d", tokenId: "t10d", outcome: "loser" },
      { conditionId: "c10d", tokenId: "t10dx", outcome: "winner" },
    ],
  },
  {
    name: "token buy cost below 1 USDC exercises the max(buyUsdc, 1) clamp",
    fills: [
      {
        conditionId: "c11a",
        tokenId: "t11a",
        side: "BUY",
        price: 0.25,
        shares: 2,
        sizeUsdc: 0.5,
        observedAt: at(10),
      },
    ],
    outcomes: [
      { conditionId: "c11a", tokenId: "t11a", outcome: "winner" },
      { conditionId: "c11a", tokenId: "t11x", outcome: "loser" },
    ],
  },
  {
    name: "condition closed but bought token has no outcome row -> pending",
    fills: buys("c12a", "t12a", [4], 10),
    outcomes: [{ conditionId: "c12a", tokenId: "t12x", outcome: "winner" }],
  },
  {
    name: "condition with an unknown outcome row -> not closed -> pending",
    fills: buys("c13a", "t13a", [4], 10),
    outcomes: [
      { conditionId: "c13a", tokenId: "t13a", outcome: "unknown" },
      { conditionId: "c13a", tokenId: "t13b", outcome: "loser" },
    ],
  },
  mixedMediumCase(),
];

function caseWalletAddress(index: number): string {
  return `0x${(index + 1).toString(16).padStart(40, "0")}`;
}

describe("trader-comparison trade-size/P-L SQL parity (bug.5008)", () => {
  const seededWalletIds: string[] = [];
  const seededConditionIds = new Set<string>();

  afterAll(async () => {
    const db = getSeedDb();
    if (seededWalletIds.length > 0) {
      await db
        .delete(polyTraderFills)
        .where(inArray(polyTraderFills.traderWalletId, seededWalletIds));
      await db
        .delete(polyTraderWallets)
        .where(inArray(polyTraderWallets.id, seededWalletIds));
    }
    if (seededConditionIds.size > 0) {
      await db
        .delete(polyMarketOutcomes)
        .where(
          inArray(polyMarketOutcomes.conditionId, [...seededConditionIds])
        );
    }
  });

  it.each(CASES.map((fixture, index) => [fixture.name, fixture, index] as const))(
    "SQL output equals legacy JS output: %s",
    async (_name, fixture, index) => {
      const db = getSeedDb();
      const walletAddress = caseWalletAddress(index);

      const inserted = await db
        .insert(polyTraderWallets)
        .values({
          walletAddress,
          kind: "copy_target",
          label: `parity-${index}`,
        })
        .returning({ id: polyTraderWallets.id });
      const walletId = inserted[0]?.id;
      if (!walletId) throw new Error("failed to seed wallet");
      seededWalletIds.push(walletId);

      if (fixture.fills.length > 0) {
        await db.insert(polyTraderFills).values(
          fixture.fills.map((fill, fillIndex) => ({
            traderWalletId: walletId,
            source: "data-api" as const,
            nativeId: `parity-${index}-${fillIndex}`,
            conditionId: fill.conditionId,
            tokenId: fill.tokenId,
            side: fill.side,
            price: String(fill.price),
            shares: String(fill.shares),
            sizeUsdc: String(fill.sizeUsdc),
            observedAt: new Date(fill.observedAt),
          }))
        );
      }
      if (fixture.outcomes.length > 0) {
        await db.insert(polyMarketOutcomes).values(
          fixture.outcomes.map((row) => ({
            conditionId: row.conditionId,
            tokenId: row.tokenId,
            outcome: row.outcome,
          }))
        );
        for (const row of fixture.outcomes) {
          seededConditionIds.add(row.conditionId);
        }
      }

      const actual = await readTradeSizePnl(
        db as unknown as ServiceDb,
        walletAddress,
        WINDOW_START_ISO
      );

      // Oracle input mirrors the legacy read: fills ordered by observed_at ASC.
      const oracleFills: OracleFill[] = [...fixture.fills]
        .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
        .map((fill) => ({
          conditionId: fill.conditionId,
          tokenId: fill.tokenId,
          side: fill.side,
          price: fill.price,
          shares: fill.shares,
          sizeUsdc: fill.sizeUsdc,
          observedAt: new Date(fill.observedAt),
        }));
      const expected = buildTradeSizePnl(
        oracleFills,
        resolutionsFromOutcomeRows(fixture.outcomes),
        new Date(WINDOW_START_ISO)
      );

      expect(actual).toEqual(expected);
      // The SQL result must also satisfy the response contract as-is.
      expect(() => PolyResearchTraderSizePnlSchema.parse(actual)).not.toThrow();
    }
  );
});
