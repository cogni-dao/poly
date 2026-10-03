// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/current-position-raw-projection`
 * Purpose: Mapper-equivalence proof for the dashboard read-path floor fix:
 *   `readCurrentWalletPositionModel` now receives scalar `raw->>` SQL
 *   projections (`raw_cur_price`, `raw_end_date`, `raw_title`,
 *   `raw_event_title`, `raw_slug`, `raw_event_slug`, `raw_outcome`)
 *   instead of the wholesale `raw` jsonb blob. A fixture row in the new
 *   shape must map to exactly the same `WalletExecutionPosition` the old
 *   V8 raw-decode produced, including every fallback branch (metadata
 *   empty-string → raw fallback, absent raw → defaults, curPrice absent →
 *   value/shares). Also asserts the emitted SQL projects the scalar paths
 *   and never selects `p.raw` wholesale.
 * Scope: Unit — fake `db.execute` returning fixture rows; no Postgres.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/current-position-read-model.ts
 * @internal
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { readCurrentWalletPositionModel } from "@/features/wallet-analysis/server/current-position-read-model";

const CAPTURED_AT = new Date("2026-09-29T00:10:00.000Z");
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

/** Row with full raw projections + empty-string Gamma title (nonEmpty fallback). */
const fullRow = {
  condition_id: "0xcond",
  token_id: "token1",
  shares: "10",
  cost_basis_usdc: "5",
  current_value_usdc: "6.5",
  avg_price: "0.5",
  last_observed_at: "2026-09-29T00:00:00.000Z",
  first_observed_at: "2026-09-28T00:00:00.000Z",
  raw_cur_price: "0.65",
  raw_end_date: "2026-10-01T00:00:00Z",
  raw_title: "Will X happen?",
  raw_event_title: "X event",
  raw_slug: "will-x",
  raw_event_slug: "x-event",
  raw_outcome: "Yes",
  cursor_last_success_at: "2026-09-29T00:05:00.000Z",
  cursor_status: "ok",
  redeem_status: null,
  redeem_lifecycle_state: null,
  market_outcome: null,
  // Empty string, not null: proves the `nonEmpty` NULLIF-mirror still
  // falls through to the raw projection (bug the old code guarded too).
  metadata_market_title: "",
  metadata_market_slug: null,
  metadata_event_title: null,
  metadata_event_slug: null,
  metadata_end_date: null,
  total_active_rows: 1,
  total_positions_mtm: "6.5",
};

/** Row with NO raw fields at all — every raw-derived default must fire. */
const bareRow = {
  ...fullRow,
  token_id: "token2",
  raw_cur_price: null,
  raw_end_date: null,
  raw_title: null,
  raw_event_title: null,
  raw_slug: null,
  raw_event_slug: null,
  raw_outcome: null,
};

function fakeDb(rows: unknown[]) {
  const captured: string[] = [];
  return {
    captured,
    execute: async (query: unknown) => {
      captured.push(new PgDialect().sqlToQuery(query as never).sql);
      return { rows };
    },
  };
}

describe("current-position read model raw->> projection equivalence", () => {
  it("maps a projected row exactly as the old wholesale-raw decode did", async () => {
    const db = fakeDb([fullRow]);
    const model = await readCurrentWalletPositionModel({
      db,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    expect(model.positions).toHaveLength(1);
    const position = model.positions[0];
    expect(position).toMatchObject({
      positionId: "0xcond:token1",
      conditionId: "0xcond",
      asset: "token1",
      // Gamma title is "" → NULLIF-mirror falls back to raw projection.
      marketTitle: "Will X happen?",
      eventTitle: "X event",
      marketSlug: "will-x",
      eventSlug: "x-event",
      marketUrl: "https://polymarket.com/event/x-event/will-x",
      outcome: "Yes",
      status: "open",
      openedAt: "2026-09-28T00:00:00.000Z",
      resolvesAt: "2026-10-01T00:00:00.000Z",
      entryPrice: 0.5,
      currentPrice: 0.65,
      size: 10,
      currentValue: 6.5,
      pnlUsd: 1.5,
      pnlPct: 30,
      syncedAt: "2026-09-29T00:00:00.000Z",
      syncAgeMs: 10 * 60_000,
      syncStale: false,
    });

    expect(model.summary).toEqual({
      positionsMtm: 6.5,
      syncedAt: "2026-09-29T00:05:00.000Z",
      syncAgeMs: 5 * 60_000,
      stale: false,
      activeRows: 1,
    });
    expect(model.warnings).toEqual([]);
  });

  it("absent raw projections hit the same defaults as absent raw keys", async () => {
    const db = fakeDb([bareRow]);
    const model = await readCurrentWalletPositionModel({
      db,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    expect(model.positions).toHaveLength(1);
    expect(model.positions[0]).toMatchObject({
      marketTitle: "Polymarket",
      eventTitle: null,
      marketSlug: null,
      eventSlug: null,
      marketUrl: null,
      outcome: "UNKNOWN",
      resolvesAt: null,
      // curPrice absent → currentValue / shares fallback.
      currentPrice: 0.65,
    });
  });

  it("preserves the exact SQL window count beyond the bounded preview", async () => {
    const db = fakeDb([
      { ...fullRow, total_active_rows: 501, total_positions_mtm: "1234.5" },
    ]);
    const model = await readCurrentWalletPositionModel({
      db,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    expect(model.positions).toHaveLength(1);
    expect(model.summary.activeRows).toBe(501);
    expect(model.summary.positionsMtm).toBe(1234.5);
    expect(db.captured[0]).toMatch(/LIMIT \$\d+/);
    expect(db.captured[0]).toContain("p.current_value_usdc > 0");
    expect(db.captured[0]).toContain("NOT IN ('redeemed', 'loser', 'dust', 'closed')");
  });

  it("SQL projects the 7 scalar raw->> paths and never selects raw wholesale", async () => {
    const db = fakeDb([]);
    await readCurrentWalletPositionModel({
      db,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    const sqlText = db.captured[0] ?? "";
    for (const key of [
      "curPrice",
      "endDate",
      "title",
      "eventTitle",
      "slug",
      "eventSlug",
      "outcome",
    ]) {
      expect(sqlText).toContain(`p.raw->>'${key}'`);
    }
    // `p.raw` may appear only as a `p.raw->>` scalar extraction.
    expect(sqlText).not.toMatch(/p\.raw\b(?!->>)/);
  });
});
