// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact closed-count/preview SQL parity with fallback keys and tied times. */
import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingAccounts, users } from "@/shared/db/schema";
import { readClosedPositionSummary } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";

const TENANT = "wallet-dashboard-closed-parity";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "wallet-dashboard-closed-parity-user";
const OBSERVED = new Date("2026-10-03T12:00:00.000Z");

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
    condition:
      typeof conditionAttribute === "string" && conditionAttribute.length > 0
        ? conditionAttribute
        : row.marketId.replace(/^prediction-market:polymarket:/, "") || row.fillId,
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
      const leftTime = Number.isFinite(leftClosed) ? leftClosed : left.observedAt.getTime();
      const rightTime = Number.isFinite(rightClosed) ? rightClosed : right.observedAt.getTime();
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
  ];

  beforeAll(async () => {
    await db.insert(users).values({ id: USER, name: USER });
    await db.insert(billingAccounts).values({
      id: TENANT,
      ownerUserId: USER,
      balanceCredits: 0n,
    });
  });

  afterAll(async () => {
    await db.delete(polyCopyTradeFills).where(eq(polyCopyTradeFills.billingAccountId, TENANT));
    await db.delete(billingAccounts).where(eq(billingAccounts.id, TENANT));
    await db.delete(users).where(eq(users.id, USER));
  });

  it("matches the pure tuple oracle and deterministic fallback-key ordering", async () => {
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

    const oracle = pureClosed(rows);
    const actual = await readClosedPositionSummary(
      db,
      TENANT,
      new Date("2026-10-03T12:01:00.000Z")
    );

    expect(actual.count).toBe(oracle.length);
    expect(actual.positions.map((position) => position.conditionId)).toEqual(
      oracle.map((row) => keys(row).condition)
    );
    expect(actual.positions.map((position) => position.asset)).toEqual(
      oracle.map((row) => keys(row).asset)
    );
    expect(actual.positions.some((position) => position.conditionId === "condition-a")).toBe(false);
  });
});
