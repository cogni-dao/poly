// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact closed-count/preview SQL parity with fallback keys and tied times. */
import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readClosedPositionSummary } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";
import { billingAccounts, users } from "@/shared/db/schema";

const TENANT = "wallet-dashboard-closed-parity";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "wallet-dashboard-closed-parity-user";
const OBSERVED = new Date("2026-10-03T12:00:00.000Z");
const CAPTURED = new Date("2026-10-07T20:30:00.000Z");

type OracleRow = {
  fillId: string;
  marketId: string;
  clientOrderId: string;
  lifecycle: string;
  observedAt: Date;
  updatedAt: Date;
  attributes: Record<string, unknown>;
};

function keys(row: OracleRow): { condition: string; asset: string } {
  const conditionAttribute = row.attributes.condition_id;
  const tokenAttribute = row.attributes.token_id;
  return {
    condition: (
      typeof conditionAttribute === "string" && conditionAttribute.length > 0
        ? conditionAttribute
        : row.marketId.replace(/^prediction-market:polymarket:/, "") || row.fillId
    ).toLowerCase(),
    asset:
      typeof tokenAttribute === "string" && tokenAttribute.length > 0
        ? tokenAttribute
        : row.clientOrderId,
  };
}

function pureClosed(rows: OracleRow[]) {
  const latest = new Map<string, OracleRow>();
  for (const row of rows) {
    const key = keys(row);
    const tuple = `${key.condition}:${key.asset}`;
    const prior = latest.get(tuple);
    if (
      !prior ||
      row.observedAt > prior.observedAt ||
      (row.observedAt.getTime() === prior.observedAt.getTime() &&
        (row.updatedAt > prior.updatedAt ||
          (row.updatedAt.getTime() === prior.updatedAt.getTime() &&
            row.clientOrderId > prior.clientOrderId)))
    ) {
      latest.set(tuple, row);
    }
  }
  return [...latest.values()]
    .filter((row) => ["closed", "redeemed", "loser", "dust"].includes(row.lifecycle))
    .sort((left, right) => {
      const leftClosed = Date.parse(String(left.attributes.closed_at ?? ""));
      const rightClosed = Date.parse(String(right.attributes.closed_at ?? ""));
      const leftTime = Number.isFinite(leftClosed)
        ? leftClosed
        : left.updatedAt.getTime();
      const rightTime = Number.isFinite(rightClosed)
        ? rightClosed
        : right.updatedAt.getTime();
      if (leftTime !== rightTime) return rightTime - leftTime;
      const leftKeys = keys(left);
      const rightKeys = keys(right);
      return (
        leftKeys.condition.localeCompare(rightKeys.condition) ||
        leftKeys.asset.localeCompare(rightKeys.asset)
      );
    });
}

describe("wallet dashboard closed SQL parity", () => {
  const db = getSeedDb();
  const rows: OracleRow[] = [
    {
      fillId: "dup-old",
      marketId: "prediction-market:polymarket:condition-a",
      clientOrderId: "client-a-old",
      lifecycle: "closed",
      observedAt: new Date("2026-10-03T10:00:00.000Z"),
      updatedAt: new Date("2026-10-03T10:00:00.000Z"),
      attributes: { condition_id: "condition-a", token_id: "token-a", closed_at: OBSERVED.toISOString() },
    },
    {
      fillId: "dup-new",
      marketId: "prediction-market:polymarket:condition-a",
      clientOrderId: "client-a-new",
      lifecycle: "abandoned",
      observedAt: new Date("2026-10-03T11:00:00.000Z"),
      updatedAt: new Date("2026-10-03T11:00:00.000Z"),
      attributes: { condition_id: "condition-a", token_id: "token-a", closed_at: OBSERVED.toISOString() },
    },
    {
      fillId: "market-fallback",
      marketId: "prediction-market:polymarket:condition-b",
      clientOrderId: "client-b",
      lifecycle: "redeemed",
      observedAt: OBSERVED,
      updatedAt: OBSERVED,
      attributes: { closed_at: OBSERVED.toISOString() },
    },
    {
      fillId: "fill-fallback",
      marketId: "",
      clientOrderId: "client-c",
      lifecycle: "loser",
      observedAt: OBSERVED,
      updatedAt: OBSERVED,
      attributes: { closed_at: OBSERVED.toISOString() },
    },
    {
      fillId: "condition-explicit",
      marketId: "ignored",
      clientOrderId: "client-d",
      lifecycle: "dust",
      observedAt: OBSERVED,
      updatedAt: OBSERVED,
      attributes: { condition_id: "condition-c", token_id: "token-d", closed_at: OBSERVED.toISOString() },
    },
    {
      fillId: "mixed-old",
      marketId: "ignored",
      clientOrderId: "client-mixed-old",
      lifecycle: "closed",
      observedAt: new Date("2026-10-03T10:30:00.000Z"),
      updatedAt: new Date("2026-10-03T10:30:00.000Z"),
      attributes: { condition_id: "CONDITION-MIXED", token_id: "token-mixed", closed_at: OBSERVED.toISOString() },
    },
    {
      fillId: "mixed-new",
      marketId: "ignored",
      clientOrderId: "client-mixed-new",
      lifecycle: "redeemed",
      observedAt: new Date("2026-10-03T11:30:00.000Z"),
      updatedAt: new Date("2026-10-03T11:30:00.000Z"),
      attributes: { condition_id: "condition-mixed", token_id: "token-mixed", closed_at: OBSERVED.toISOString() },
    },
    {
      fillId: "window-recent",
      marketId: "ignored",
      clientOrderId: "window-recent-client",
      lifecycle: "closed",
      observedAt: new Date("2026-10-07T20:00:00.000Z"),
      updatedAt: new Date("2026-10-07T20:15:00.000Z"),
      attributes: { condition_id: "window-recent", token_id: "window-recent-token" },
    },
    {
      fillId: "window-1d-boundary",
      marketId: "ignored",
      clientOrderId: "window-1d-boundary-client",
      lifecycle: "closed",
      observedAt: new Date("2026-10-06T20:30:00.000Z"),
      updatedAt: new Date("2026-10-06T20:30:00.000Z"),
      attributes: { condition_id: "window-1d-boundary", token_id: "window-1d-boundary-token", closed_at: "2026-10-06T20:30:00.000Z" },
    },
    {
      fillId: "window-before-1d",
      marketId: "ignored",
      clientOrderId: "window-before-1d-client",
      lifecycle: "closed",
      observedAt: new Date("2026-10-06T20:29:59.999Z"),
      updatedAt: new Date("2026-10-06T20:29:59.999Z"),
      attributes: { condition_id: "window-before-1d", token_id: "window-before-1d-token", closed_at: "2026-10-06T20:29:59.999Z" },
    },
    {
      fillId: "window-1w-boundary",
      marketId: "ignored",
      clientOrderId: "window-1w-boundary-client",
      lifecycle: "closed",
      observedAt: new Date("2026-09-30T20:30:00.000Z"),
      updatedAt: new Date("2026-09-30T20:30:00.000Z"),
      attributes: { condition_id: "window-1w-boundary", token_id: "window-1w-boundary-token", closed_at: "2026-09-30T20:30:00.000Z" },
    },
    {
      fillId: "window-1m-boundary",
      marketId: "ignored",
      clientOrderId: "window-1m-boundary-client",
      lifecycle: "closed",
      observedAt: new Date("2026-09-07T20:30:00.000Z"),
      updatedAt: new Date("2026-09-07T20:30:00.000Z"),
      attributes: { condition_id: "window-1m-boundary", token_id: "window-1m-boundary-token", closed_at: "2026-09-07T20:30:00.000Z" },
    },
    {
      fillId: "window-1y-boundary",
      marketId: "ignored",
      clientOrderId: "window-1y-boundary-client",
      lifecycle: "closed",
      observedAt: new Date("2025-10-07T20:30:00.000Z"),
      updatedAt: new Date("2025-10-07T20:30:00.000Z"),
      attributes: { condition_id: "window-1y-boundary", token_id: "window-1y-boundary-token", closed_at: "2025-10-07T20:30:00.000Z" },
    },
    {
      fillId: "window-ytd-boundary",
      marketId: "ignored",
      clientOrderId: "window-ytd-boundary-client",
      lifecycle: "closed",
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      attributes: { condition_id: "window-ytd-boundary", token_id: "window-ytd-boundary-token", closed_at: "2026-01-01T00:00:00.000Z" },
    },
    {
      fillId: "window-before-ytd",
      marketId: "ignored",
      clientOrderId: "window-before-ytd-client",
      lifecycle: "closed",
      observedAt: new Date("2025-12-31T23:59:59.999Z"),
      updatedAt: new Date("2025-12-31T23:59:59.999Z"),
      attributes: { condition_id: "window-before-ytd", token_id: "window-before-ytd-token", closed_at: "2025-12-31T23:59:59.999Z" },
    },
    {
      fillId: "window-before-1y",
      marketId: "ignored",
      clientOrderId: "window-before-1y-client",
      lifecycle: "closed",
      observedAt: new Date("2025-10-07T20:29:59.999Z"),
      updatedAt: new Date("2025-10-07T20:29:59.999Z"),
      attributes: { condition_id: "window-before-1y", token_id: "window-before-1y-token", closed_at: "2025-10-07T20:29:59.999Z" },
    },
  ];

  beforeAll(async () => {
    await db.insert(users).values({ id: USER, name: USER });
    await db.insert(billingAccounts).values({
      id: TENANT,
      ownerUserId: USER,
      balanceCredits: 0n,
    });
    await db.insert(polyCopyTradeFills).values(
      rows.map((row) => ({
        billingAccountId: TENANT,
        createdByUserId: USER,
        targetId: TARGET,
        fillId: row.fillId,
        marketId: row.marketId,
        observedAt: row.observedAt,
        clientOrderId: row.clientOrderId,
        status: "filled",
        positionLifecycle: row.lifecycle,
        attributes: row.attributes,
        updatedAt: row.updatedAt,
      }))
    );
  });

  afterAll(async () => {
    await db.delete(polyCopyTradeFills).where(eq(polyCopyTradeFills.billingAccountId, TENANT));
    await db.delete(billingAccounts).where(eq(billingAccounts.id, TENANT));
    await db.delete(users).where(eq(users.id, USER));
  });

  it("matches the pure tuple oracle and deterministic fallback-key ordering", async () => {

    const oracle = pureClosed(rows);
    const actual = await readClosedPositionSummary(
      db,
      TENANT,
      CAPTURED,
      "ALL"
    );

    expect(actual.count).toBe(oracle.length);
    expect(actual.positions.map((position) => position.conditionId)).toEqual(
      oracle.map((row) => keys(row).condition)
    );
    expect(actual.positions.map((position) => position.asset)).toEqual(
      oracle.map((row) => keys(row).asset)
    );
    expect(actual.positions.some((position) => position.conditionId === "condition-a")).toBe(false);
    expect(
      actual.positions.filter(
        (position) => position.conditionId === "condition-mixed"
      )
    ).toHaveLength(1);
    expect(
      actual.positions.find(
        (position) => position.conditionId === "condition-mixed"
      )?.positionId
    ).toBe("condition-mixed:token-mixed");
  });

  it.each([
    ["1D", 2],
    ["1W", 8],
    ["1M", 9],
    ["1Y", 12],
    ["YTD", 10],
    ["ALL", 13],
  ] as const)(
    "filters the exact count and preview at the inclusive %s cutoff",
    async (interval, expectedCount) => {
      const actual = await readClosedPositionSummary(
        db,
        TENANT,
        CAPTURED,
        interval
      );

      expect(actual.count).toBe(expectedCount);
      expect(actual.positions).toHaveLength(expectedCount);
    }
  );
});
