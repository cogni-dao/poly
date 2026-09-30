// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/features/trading/ledger-row-projection`
 * Purpose: Mapper-equivalence proof for the `listTenantPositions` /
 *   `listRecent` explicit column projection (dashboard read-path floor
 *   fix): `mapLedgerRow` over the narrowed `LEDGER_ROW_COLUMNS` selection
 *   produces exactly the same `LedgerRow` as over a full `SELECT *` row —
 *   i.e. none of the excluded columns (`createdByUserId`, `marketId`,
 *   `price`, `shares`, `feesUsdc`) ever influenced the mapped output.
 * Scope: Unit — pure mapper; no DB.
 * Side-effects: none
 * Links: src/features/trading/order-ledger.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  type LedgerSelectedRow,
  mapLedgerRow,
} from "@/features/trading/order-ledger";

const projectedRow: LedgerSelectedRow = {
  targetId: "33333333-3333-4333-8333-333333333333",
  fillId: "data-api:fill-1",
  observedAt: new Date("2026-09-29T00:00:00.000Z"),
  clientOrderId: "coid-1",
  orderId: "order-1",
  status: "filled",
  positionLifecycle: "open",
  attributes: {
    side: "BUY",
    size_usdc: 25,
    limit_price: 0.5,
    token_id: "token1",
    condition_id: "0xcond",
    title: "Will X happen?",
    filled_size_usdc: 25,
  },
  syncedAt: new Date("2026-09-29T00:01:00.000Z"),
  createdAt: new Date("2026-09-29T00:00:01.000Z"),
  updatedAt: new Date("2026-09-29T00:02:00.000Z"),
  billingAccountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mode: "live",
};

/** The same row as a full `SELECT *` would return it — extra columns present. */
const fullRow = {
  ...projectedRow,
  createdByUserId: "11111111-1111-4111-8111-111111111111",
  marketId: "0xcond",
  price: "0.50000000",
  shares: "50.00000000",
  feesUsdc: "0.00000000",
};

describe("mapLedgerRow projection equivalence (dashboard floor fix)", () => {
  it("the projected row maps identically to the full row", () => {
    expect(mapLedgerRow(projectedRow)).toEqual(mapLedgerRow(fullRow));
  });

  it("maps every LedgerRow field from the projected columns", () => {
    const row = mapLedgerRow(projectedRow);
    expect(row).toEqual({
      target_id: projectedRow.targetId,
      fill_id: projectedRow.fillId,
      observed_at: projectedRow.observedAt,
      client_order_id: projectedRow.clientOrderId,
      order_id: projectedRow.orderId,
      status: "filled",
      position_lifecycle: "open",
      attributes: projectedRow.attributes,
      synced_at: projectedRow.syncedAt,
      created_at: projectedRow.createdAt,
      updated_at: projectedRow.updatedAt,
      billing_account_id: projectedRow.billingAccountId,
      mode: "live",
    });
  });

  it("excluded realized/tenant columns cannot influence the mapped output", () => {
    const mutatedExtras = {
      ...fullRow,
      createdByUserId: "99999999-9999-4999-8999-999999999999",
      marketId: "totally-different",
      price: "0.99000000",
      shares: "1.00000000",
      feesUsdc: "9.99000000",
    };
    expect(mapLedgerRow(mutatedExtras)).toEqual(mapLedgerRow(projectedRow));
  });
});
