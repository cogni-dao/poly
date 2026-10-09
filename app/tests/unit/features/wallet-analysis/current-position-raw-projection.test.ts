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
const BILLING_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
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
  eligible_wallet_count: 1,
  wallet_identity_count: 1,
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
  target_correlated: false,
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
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    expect(model.positions).toHaveLength(1);
    expect(model.targetCorrelatedKeys.size).toBe(0);
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
      hasSuccessfulObservation: true,
      cursorStatus: "ok",
      identityAmbiguous: false,
    });
    expect(model.warnings).toEqual([]);
  });

  it("returns exact target-correlated keys for bounded preview priority", async () => {
    const model = await readCurrentWalletPositionModel({
      db: fakeDb([{ ...fullRow, target_correlated: true }]),
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    expect([...model.targetCorrelatedKeys]).toEqual(["0xcond:token1"]);
  });

  it("absent raw projections hit the same defaults as absent raw keys", async () => {
    const db = fakeDb([bareRow]);
    const model = await readCurrentWalletPositionModel({
      db,
      billingAccountId: BILLING_ACCOUNT,
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
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    expect(model.positions).toHaveLength(1);
    expect(model.summary.activeRows).toBe(501);
    expect(model.summary.positionsMtm).toBe(1234.5);
    expect(db.captured[0]).toMatch(/LIMIT \$\d+/);
    expect(db.captured[0]).toContain("p.current_value_usdc > 0");
    expect(db.captured[0]).toContain("NOT IN ('redeemed', 'loser', 'dust', 'closed')");
    expect(db.captured[0]).toContain("lower(w.wallet_address) = lower(");
    expect(db.captured[0]).toContain(
      "w.kind IN ('cogni_wallet', 'paper_wallet')"
    );
    expect(db.captured[0]).toContain("WHEN w.kind = 'paper_wallet' THEN");
    expect(db.captured[0]).toContain(
      "PARTITION BY lower(p.condition_id), p.token_id"
    );
    expect(db.captured[0].indexOf("row_number() OVER")).toBeLessThan(
      db.captured[0].indexOf("p.active = true")
    );
    expect(db.captured[0]).toMatch(
      /ORDER BY\s+\(correlated\.token_id IS NOT NULL\) DESC,\s+p\.current_value_usdc DESC NULLS LAST,\s+p\.last_observed_at DESC NULLS LAST,\s+p\.condition_id ASC NULLS LAST,\s+p\.token_id ASC NULLS LAST\s+LIMIT \$\d+/
    );
  });

  it("distinguishes never-observed and partial cursors from a real observed zero", async () => {
    const neverObserved = await readCurrentWalletPositionModel({
      db: fakeDb([
        {
          ...fullRow,
          condition_id: null,
          token_id: null,
          cursor_last_success_at: null,
          cursor_status: null,
          total_active_rows: 0,
          total_positions_mtm: 0,
        },
      ]),
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });
    expect(neverObserved.summary.hasSuccessfulObservation).toBe(false);
    expect(neverObserved.warnings).toContainEqual(
      expect.objectContaining({ code: "current_positions_never_observed" })
    );

    const partial = await readCurrentWalletPositionModel({
      db: fakeDb([{ ...fullRow, cursor_status: "partial" }]),
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });
    expect(partial.summary.hasSuccessfulObservation).toBe(true);
    expect(partial.summary.cursorStatus).toBe("partial");
    expect(partial.summary.activeRows).toBe(1);
    expect(partial.summary.positionsMtm).toBe(6.5);
    expect(partial.warnings).toContainEqual(
      expect.objectContaining({ code: "current_positions_partial" })
    );
  });

  it("SQL projects the 7 scalar raw->> paths and never selects raw wholesale", async () => {
    const db = fakeDb([]);
    await readCurrentWalletPositionModel({
      db,
      billingAccountId: BILLING_ACCOUNT,
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
    expect(sqlText).toContain("target_correlated_positions");
    expect(sqlText).toContain("(correlated.token_id IS NOT NULL) DESC");
  });

  it("canonicalizes emitted condition identity and joins saved facts case-insensitively", async () => {
    const db = fakeDb([{ ...fullRow, condition_id: "MiXeD-Condition" }]);
    const model = await readCurrentWalletPositionModel({
      db,
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: WALLET.toUpperCase(),
      capturedAt: CAPTURED_AT,
    });

    expect(model.positions[0]?.conditionId).toBe("mixed-condition");
    const sqlText = db.captured[0] ?? "";
    expect(sqlText).toContain("lower(candidate.condition_id) = lower(p.condition_id)");
    expect(sqlText).toContain("lower(candidate.funder_address) = lower(");
  });

  it("coalesces wallet siblings and marks their retained position fact ambiguous", async () => {
    const model = await readCurrentWalletPositionModel({
      db: fakeDb([{ ...fullRow, wallet_identity_count: 2 }]),
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: WALLET,
      capturedAt: CAPTURED_AT,
    });

    expect(model.positions).toHaveLength(1);
    expect(model.summary.identityAmbiguous).toBe(true);
    expect(model.warnings).toContainEqual(
      expect.objectContaining({ code: "current_positions_identity_ambiguous" })
    );
  });
});
