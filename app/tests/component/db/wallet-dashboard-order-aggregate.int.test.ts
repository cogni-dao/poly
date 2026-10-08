// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Exact order aggregate is independent of the former 2,000-row preview cap. */
import { polyCopyTradeFills } from "@cogni/db-schema/copy-trade";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingAccounts, users } from "@/shared/db/schema";
import { readOrderSummary } from "@/features/wallet-analysis/server/tenant-wallet-dashboard-service";

const TENANT_A = "wallet-dashboard-orders-a";
const TENANT_B = "wallet-dashboard-orders-b";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "wallet-dashboard-orders-user-a";
const USER_B = "wallet-dashboard-orders-user-b";
const CAPTURED_AT = "2026-10-03T12:00:00.000Z";

describe("wallet dashboard order aggregate", () => {
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
  });

  afterAll(async () => {
    await db
      .delete(polyCopyTradeFills)
      .where(inArray(polyCopyTradeFills.billingAccountId, [TENANT_A, TENANT_B]));
    await db
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, [TENANT_A, TENANT_B]));
    await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  });

  it("returns an exact >2,000 count, isolates tenants, and never coerces malformed BUY notional to zero", async () => {
    const observedAt = new Date(CAPTURED_AT);
    await db.insert(polyCopyTradeFills).values(
      Array.from({ length: 2_001 }, (_, index) => ({
        billingAccountId: TENANT_A,
        createdByUserId: USER_A,
        targetId: TARGET,
        fillId: `fill-${index}`,
        marketId: `market-${index}`,
        observedAt,
        clientOrderId: `client-${index}`,
        status: "open",
        positionLifecycle: "open",
        syncedAt: observedAt,
        attributes: {
          side: "BUY",
          size_usdc: index === 0 ? "not-a-number" : "2.00",
          filled_size_usdc: "0.50",
        },
      }))
    );
    await db.insert(polyCopyTradeFills).values([
      {
        billingAccountId: TENANT_B,
        createdByUserId: USER_B,
        targetId: TARGET,
        fillId: "other-fill",
        marketId: "other-market",
        observedAt,
        clientOrderId: "other-client",
        status: "open",
        positionLifecycle: "open",
        syncedAt: observedAt,
        attributes: { side: "BUY", size_usdc: "999", filled_size_usdc: "0" },
      },
      {
        billingAccountId: TENANT_B,
        createdByUserId: USER_B,
        targetId: TARGET,
        fillId: "pg-pending",
        marketId: "pg-pending-market",
        observedAt,
        clientOrderId: "pg-pending-client",
        status: "partial",
        positionLifecycle: "open",
        syncedAt: observedAt,
        attributes: {
          side: "BUY",
          size_usdc: "5",
          filled_size_usdc: "4",
          position_gap_version: "3",
        },
      },
      {
        billingAccountId: TENANT_B,
        createdByUserId: USER_B,
        targetId: TARGET,
        fillId: "pg-verified",
        marketId: "pg-verified-market",
        observedAt,
        clientOrderId: "pg-verified-client",
        status: "partial",
        positionLifecycle: "open",
        syncedAt: observedAt,
        attributes: {
          side: "BUY",
          size_usdc: "5",
          filled_size_usdc: "0.01",
          position_gap_version: "3",
          realized_fill_source: "clob_associated_trades",
        },
      },
    ]);

    const tenantA = await readOrderSummary(db, TENANT_A, CAPTURED_AT);
    expect(tenantA.openOrders).toBe(2_001);
    expect(tenantA.malformedBuyRows).toBe(1);
    expect(tenantA.lockedUsdc).toBeNull();
    expect(tenantA.observedAt).toBe(CAPTURED_AT);

    const tenantB = await readOrderSummary(db, TENANT_B, CAPTURED_AT);
    expect(tenantB.openOrders).toBe(3);
    // Pending PG accounting reserves the full intent; verified accounting may
    // release only its authoritative gross execution notional.
    expect(tenantB.lockedUsdc).toBe(1_008.99);

    const empty = await readOrderSummary(db, "wallet-dashboard-orders-empty", CAPTURED_AT);
    expect(empty).toMatchObject({
      openOrders: 0,
      lockedUsdc: 0,
      observedAt: null,
      malformedBuyRows: 0,
    });
  });
});
