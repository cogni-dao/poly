// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact interval boundaries, adaptive buckets, and tenant isolation for wallet trade activity. */
import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTradeActivity } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import { billingAccounts, users } from "@/shared/db/schema";

const TENANT_A = "wallet-dashboard-trade-activity-a";
const TENANT_B = "wallet-dashboard-trade-activity-b";
const USER_A = "wallet-dashboard-trade-activity-user-a";
const USER_B = "wallet-dashboard-trade-activity-user-b";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAPTURED = new Date("2026-10-08T12:30:00.000Z");

type SeedTrade = {
  id: string;
  observedAt: string;
  attributes?: Record<string, unknown>;
};

const tenantATrades: SeedTrade[] = [
  { id: "before-1y", observedAt: "2025-10-08T12:29:59.999Z" },
  { id: "at-1y", observedAt: "2025-10-08T12:30:00.000Z" },
  { id: "before-ytd", observedAt: "2025-12-31T23:59:59.999Z" },
  { id: "at-ytd", observedAt: "2026-01-01T00:00:00.000Z" },
  { id: "at-1m", observedAt: "2026-09-08T12:30:00.000Z" },
  { id: "at-1w", observedAt: "2026-10-01T12:30:00.000Z" },
  { id: "before-1d", observedAt: "2026-10-07T12:29:59.999Z" },
  { id: "at-1d", observedAt: "2026-10-07T12:30:00.000Z" },
  {
    id: "size-fallback",
    observedAt: "2026-10-08T09:00:00.000Z",
    attributes: { size_usdc: "2" },
  },
  {
    id: "position-gap-verified",
    observedAt: "2026-10-08T10:30:00.000Z",
    attributes: {
      position_gap_version: "3",
      realized_fill_source: "data_api_activity_position",
      filled_size_usdc: "1",
    },
  },
  { id: "mid-hour", observedAt: "2026-10-08T11:45:00.000Z" },
  { id: "at-captured", observedAt: "2026-10-08T12:30:00.000Z" },
  { id: "after-captured", observedAt: "2026-10-08T12:30:00.001Z" },
  {
    id: "position-gap-unverified",
    observedAt: "2026-10-08T10:00:00.000Z",
    attributes: {
      position_gap_version: "3",
      filled_size_usdc: "1",
    },
  },
];

describe("wallet dashboard trade activity", () => {
  const db = getSeedDb();

  beforeAll(async () => {
    await db.insert(users).values([
      { id: USER_A, name: USER_A },
      { id: USER_B, name: USER_B },
    ]);
    await db.insert(billingAccounts).values([
      { id: TENANT_A, ownerUserId: USER_A, balanceCredits: 0n },
      { id: TENANT_B, ownerUserId: USER_B, balanceCredits: 0n },
    ]);
    await db.insert(polyCopyTradeFills).values([
      ...tenantATrades.map((trade) => ({
        billingAccountId: TENANT_A,
        createdByUserId: USER_A,
        targetId: TARGET,
        fillId: trade.id,
        marketId: `market-${trade.id}`,
        observedAt: new Date(trade.observedAt),
        clientOrderId: `client-${trade.id}`,
        status: "filled",
        attributes: trade.attributes ?? {
          size_usdc: "1",
          filled_size_usdc: "1",
        },
      })),
      {
        billingAccountId: TENANT_B,
        createdByUserId: USER_B,
        targetId: TARGET,
        fillId: "other-tenant",
        marketId: "other-tenant-market",
        observedAt: new Date("2026-10-08T11:00:00.000Z"),
        clientOrderId: "other-tenant-client",
        status: "filled",
        attributes: { size_usdc: "1", filled_size_usdc: "1" },
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(polyCopyTradeFills)
      .where(
        inArray(polyCopyTradeFills.billingAccountId, [TENANT_A, TENANT_B])
      );
    await db
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, [TENANT_A, TENANT_B]));
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  });

  it.each([
    ["1D", "hour", 24, 5],
    ["1W", "day", 7, 7],
    ["1M", "day", 30, 8],
    ["1Y", "month", 13, 11],
    ["YTD", "month", 10, 9],
    ["ALL", "year", 2, 12],
  ] as const)(
    "returns %s as %s buckets with exact cutoff facts",
    async (interval, expectedUnit, expectedBuckets, expectedTotal) => {
      const actual = await readTradeActivity(
        db,
        TENANT_A,
        CAPTURED,
        interval
      );

      expect(actual.bucketUnit).toBe(expectedUnit);
      expect(actual.buckets).toHaveLength(expectedBuckets);
      expect(actual.buckets.reduce((sum, bucket) => sum + bucket.n, 0)).toBe(
        expectedTotal
      );
    }
  );

  it("includes both exact rolling boundaries and the captured-at instant", async () => {
    const day = await readTradeActivity(db, TENANT_A, CAPTURED, "1D");
    expect(day.buckets[0]).toEqual({
      start: "2026-10-07T12:30:00.000Z",
      n: 1,
    });
    expect(day.buckets.at(-1)).toEqual({
      start: "2026-10-08T11:30:00.000Z",
      n: 2,
    });

    const otherTenant = await readTradeActivity(
      db,
      TENANT_B,
      CAPTURED,
      "1D"
    );
    expect(otherTenant.buckets.reduce((sum, bucket) => sum + bucket.n, 0)).toBe(
      1
    );
  });
});
