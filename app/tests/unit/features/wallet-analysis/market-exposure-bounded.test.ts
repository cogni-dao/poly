// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Bounded dashboard market mode: cardinality and canonical semantic parity. */
import type { WalletExecutionPosition } from "@cogni/poly-node-contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildBoundedMarketExposureGroups } from "@/features/wallet-analysis/server/market-exposure-service";

const OUR = `0x${"1".repeat(40)}`;
const TARGET = `0x${"2".repeat(40)}`;

function position(index = 0): WalletExecutionPosition {
  return {
    positionId: `condition-${index}:our-${index}`,
    conditionId: `condition-${index}`,
    asset: `our-${index}`,
    marketTitle: `Market ${index}`,
    eventTitle: `Event ${index}`,
    marketSlug: `market-${index}`,
    eventSlug: `event-${index}`,
    marketUrl: null,
    outcome: "Yes",
    status: "open",
    lifecycleState: "open",
    openedAt: "2026-10-03T00:00:00.000Z",
    closedAt: null,
    resolvesAt: null,
    size: 10,
    entryPrice: 0.5,
    currentPrice: 0.6,
    currentValue: 6,
    pnlUsd: 1,
    pnlPct: 20,
    heldMinutes: 1,
    timeline: [],
    events: [],
  };
}

function targetParticipant(overrides?: Record<string, unknown>) {
  return {
    total_participants: 1,
    group_truncated: false,
    group_key: "event:event-0",
    wallet_address: TARGET,
    label: "Target",
    condition_id: "condition-0",
    legs: [
      {
        token_id: "target-primary",
        market_title: "Market 0",
        event_title: "Event 0",
        market_slug: "market-0",
        event_slug: "event-0",
        outcome: "Yes",
        shares: "16",
        cost_basis_usdc: "8",
        current_value_usdc: "10",
        avg_price: "0.5",
        last_observed_at: "2026-10-03T00:00:00.000Z",
        lifecycle: "active",
      },
      {
        token_id: "target-hedge",
        market_title: "Market 0",
        event_title: "Event 0",
        market_slug: "market-0",
        event_slug: "event-0",
        outcome: "No",
        shares: "6",
        cost_basis_usdc: "3",
        current_value_usdc: "2",
        avg_price: "0.5",
        last_observed_at: "2026-10-03T00:00:00.000Z",
        lifecycle: "active",
      },
    ],
    ...overrides,
  };
}

function fakeDb(targetRows: unknown[], rollupRows: unknown[] = []) {
  const sql: string[] = [];
  let call = 0;
  return {
    sql,
    execute: async (query: unknown) => {
      sql.push(new PgDialect().sqlToQuery(query as never).sql);
      call += 1;
      if (call === 1) return targetRows;
      if (call === 2) return [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }];
      return rollupRows;
    },
  };
}

describe("bounded market exposure", () => {
  it("hydrates one SQL participant with canonical primary+hedge and keeps gross BUY distinct from snapshot cost", async () => {
    const db = fakeDb([targetParticipant()], [
      {
        wallet_address: TARGET,
        condition_id: "condition-0",
        token_id: "target-primary",
        total_buy_notional: "30",
        realized_cash: "0",
        net_shares: "16",
        market_outcome: "unknown",
      },
      {
        wallet_address: TARGET,
        condition_id: "condition-0",
        token_id: "target-hedge",
        total_buy_notional: "5",
        realized_cash: "0",
        net_shares: "6",
        market_outcome: "unknown",
      },
    ]);

    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });

    const line = read.groups[0]?.lines[0];
    const target = line?.participants.find((row) => row.side === "copy_target");
    expect(target?.primary?.tokenId).toBe("target-primary");
    expect(target?.hedge?.tokenId).toBe("target-hedge");
    expect(line?.targetEntryValueUsdc).toBe(11);
    expect(line?.targetGrossBuyNotionalUsdc).toBe(35);
    expect(read.truncated).toBe(false);
    expect(db.sql[0]).toContain("jsonb_agg");
    expect(db.sql[0]).toContain("group_rank <=");
    expect(db.sql[2]).toContain("selected_keys");
  });

  it("marks partial when a group exceeds ten target participants", async () => {
    const db = fakeDb([
      targetParticipant({ total_participants: 10, group_truncated: true }),
    ]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });
    expect(read.truncated).toBe(true);
  });

  it("marks partial when the global participant budget truncates selected rows", async () => {
    const db = fakeDb([
      targetParticipant({ total_participants: 2_000, group_truncated: false }),
    ]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: [position()],
    });
    expect(read.truncated).toBe(true);
  });

  it("caps our event groups at 200 and marks the preview partial", async () => {
    const db = fakeDb([]);
    const read = await buildBoundedMarketExposureGroups({
      db,
      billingAccountId: "tenant-a",
      walletAddress: OUR,
      livePositions: Array.from({ length: 201 }, (_, index) => position(index)),
    });
    expect(read.groups).toHaveLength(200);
    expect(read.truncated).toBe(true);
  });
});
