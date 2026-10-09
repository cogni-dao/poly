// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/wallet-analysis/market-exposure-snapshot-sql`
 * Purpose: Guard the dashboard read-path floor fixes inside
 *   `readTargetLegs`' latest_snapshots CTE:
 *   (1) DISTINCT ON canonicalizes wallet + condition identity and uses
 *       `captured_at DESC NULLS LAST` with deterministic physical tiebreaks;
 *   (2) the Data-API `raw` jsonb is projected to 5 scalar `raw->>` fields
 *       and never selected wholesale;
 *   and prove the target-leg mapping (raw fallbacks included) is unchanged
 *   by feeding a fixture row through `buildMarketExposureGroups`.
 * Scope: Unit — fake `db.execute` capturing rendered SQL; no Postgres.
 * Side-effects: none
 * Links: src/features/wallet-analysis/server/market-exposure-service.ts,
 *        app/src/adapters/server/db/migrations/0063_stiff_robin_chapel.sql
 * @internal
 */

import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  buildBoundedMarketExposureWithCoverage,
  buildMarketExposureGroups,
} from "@/features/wallet-analysis/server/market-exposure-service";

const BILLING_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUR_WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TARGET_WALLET = "0x1234123412341234123412341234123412341234";
const CONDITION = "0xcond";

const ourPosition: WalletExecutionPosition = {
  positionId: `${CONDITION}:token1`,
  conditionId: CONDITION,
  asset: "token1",
  marketTitle: "Will X happen?",
  eventTitle: null,
  marketSlug: "will-x",
  eventSlug: null,
  marketUrl: null,
  outcome: "Yes",
  status: "open",
  lifecycleState: null,
  openedAt: "2026-09-28T00:00:00.000Z",
  closedAt: null,
  resolvesAt: null,
  gameStartTime: null,
  heldMinutes: 60,
  entryPrice: 0.5,
  currentPrice: 0.65,
  size: 10,
  currentValue: 6.5,
  pnlUsd: 1.5,
  pnlPct: 30,
  syncedAt: "2026-09-29T00:00:00.000Z",
  syncAgeMs: 0,
  syncStale: false,
  timeline: [],
  events: [],
};

/** Target row as the outer SELECT aliases it — raw_* fallbacks in play. */
const targetRow = {
  wallet_address: TARGET_WALLET,
  label: "Copy target",
  condition_id: CONDITION,
  token_id: "token1",
  market_title: "Will X happen? (raw)",
  event_title: null,
  market_slug: "will-x",
  event_slug: null,
  outcome: "Yes",
  shares: "20",
  cost_basis_usdc: "8",
  current_value_usdc: "13",
  avg_price: "0.4",
  last_observed_at: "2026-09-29T00:00:00.000Z",
  lifecycle: "active",
};

function fakeDb() {
  const captured: string[] = [];
  let call = 0;
  return {
    captured,
    execute: async (query: unknown) => {
      captured.push(new PgDialect().sqlToQuery(query as never).sql);
      call += 1;
      // 1st execute = readTargetLegs; 2nd = readFillRollups. The service
      // casts the execute result to a row ARRAY (postgres-js shape).
      return call === 1 ? [targetRow] : [];
    },
  };
}

describe("market-exposure latest_snapshots CTE (dashboard floor fix)", () => {
  it("dedupes snapshots on canonical condition identity with a deterministic latest row", async () => {
    const db = fakeDb();
    await buildMarketExposureGroups({
      db,
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: OUR_WALLET,
      livePositions: [ourPosition],
    });

    const snapshotSql = db.captured[0] ?? "";
    expect(snapshotSql).toMatch(
      /DISTINCT ON \(a\.wallet_address, lower\(s\.condition_id\), s\.token_id\)/
    );
    expect(snapshotSql).toMatch(
      /ORDER BY a\.wallet_address, lower\(s\.condition_id\), s\.token_id,\s+s\.captured_at DESC NULLS LAST, s\.condition_id, s\.trader_wallet_id/
    );
    expect(snapshotSql).toContain("WHERE lower(s.condition_id) IN");
  });

  it("projects 5 scalar raw->> fields and never selects the raw blob wholesale", async () => {
    const db = fakeDb();
    await buildMarketExposureGroups({
      db,
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: OUR_WALLET,
      livePositions: [ourPosition],
    });

    const snapshotSql = db.captured[0] ?? "";
    for (const key of ["title", "eventTitle", "slug", "eventSlug", "outcome"]) {
      expect(snapshotSql).toContain(`s.raw->>'${key}'`);
    }
    // `s.raw` may appear only as a scalar extraction; `ls.raw` (the old
    // wholesale pass-through out of the CTE) must be gone entirely.
    expect(snapshotSql).not.toMatch(/s\.raw\b(?!->>)/);
    expect(snapshotSql).not.toMatch(/ls\.raw\b/);
  });

  it("maps the target leg the same as before the projection (raw fallbacks intact)", async () => {
    const db = fakeDb();
    const groups = await buildMarketExposureGroups({
      db,
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: OUR_WALLET,
      livePositions: [ourPosition],
    });

    expect(groups).toHaveLength(1);
    const line = groups[0]?.lines[0];
    expect(line?.conditionId).toBe(CONDITION);
    const targetParticipant = line?.participants.find(
      (p) => p.side === "copy_target"
    );
    expect(targetParticipant).toBeDefined();
    expect(targetParticipant?.walletAddress).toBe(TARGET_WALLET);
    expect(targetParticipant?.primary).toMatchObject({
      tokenId: "token1",
      outcome: "Yes",
      shares: 20,
      costBasisUsdc: 8,
      currentValueUsdc: 13,
      lifecycle: "active",
    });
  });

  it("never falls back from unverified Position-gap fills to intended closed cost", async () => {
    const captured: string[] = [];
    const db = {
      execute: async (query: unknown) => {
        captured.push(new PgDialect().sqlToQuery(query as never).sql);
        return [];
      },
    };
    await buildBoundedMarketExposureWithCoverage({
      db,
      billingAccountId: BILLING_ACCOUNT,
      walletAddress: OUR_WALLET,
      connectionKind: "privy_live",
      livePositions: [],
      closedPositions: [
        {
          ...ourPosition,
          status: "closed",
          lifecycleState: "closed",
          closedAt: "2026-09-30T00:00:00.000Z",
        },
      ],
    });

    const comparisonSql = captured[0] ?? "";
    expect(comparisonSql).toContain("attributes->>'position_gap_version'");
    expect(comparisonSql).toContain("attributes->>'realized_fill_source'");
    expect(comparisonSql).toMatch(
      /position_gap_version[^]*NOT IN \('clob_associated_trades', 'data_api_activity_position'\)[^]*THEN NULL[^]*filled_size_usdc[^]*size_usdc/
    );
    expect(comparisonSql).toContain(
      "own_cost IS NULL OR l.own_cost <= 0"
    );
  });
});
