// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { toExecuted } from "@/features/wallet-analysis/server/copy-trade-attempts-read";
import {
  toContractRow,
} from "@/features/wallet-analysis/server/copy-trade-orders-read";

const date = new Date("2026-10-07T00:00:00.000Z");

function orderRow(attributes: Record<string, unknown>) {
  return {
    targetId: "11111111-1111-4111-8111-111111111111",
    fillId: "fill-1",
    clientOrderId: "client-1",
    orderId: "order-1",
    status: "filled",
    marketId: "market-1",
    observedAt: date,
    createdAt: date,
    updatedAt: date,
    syncedAt: date,
    mode: "live",
    shares: "9.3",
    attributes,
    metadataMarketTitle: null,
  };
}

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: "11111111-1111-4111-8111-111111111112",
    decided_at: date,
    target_id: "11111111-1111-4111-8111-111111111111",
    target_wallet: null,
    fill_id: "fill-1",
    market_id: "market-1",
    mode: "live",
    outcome: "placed" as const,
    reason: null,
    intended_side: "BUY",
    intended_token_id: "token-1",
    intended_limit_price: 0.386,
    intended_size_usdc: 3.5898,
    position_branch: null,
    target_position_usdc: null,
    exec_status: "filled",
    exec_order_id: "order-1",
    exec_observed_at: date,
    exec_position_lifecycle: "loser",
    exec_price: 0.386,
    exec_shares: 9.3,
    exec_fees_usdc: null,
    exec_filled_size_usdc: 3.5898,
    exec_position_gap_version: "3",
    exec_realized_fill_source: null,
    exec_synced_at: date,
    mark_price: null,
    mark_observed_at: null,
    resolution: null,
    resolution_payout: null,
    resolution_resolved_at: null,
    ...overrides,
  } as Parameters<typeof toExecuted>[0];
}

describe("Position-gap public fill accounting", () => {
  // Orders metadata is proved with real PostgreSQL in position-metadata-read.int.test.ts.
  // The removed SQL-string/mock-row cases certified the old unscoped target lookup and numeric indexes.
  it("prefers canonical market metadata over the numeric outcome label", () => {
    const order = toContractRow(
      {
        ...orderRow({ title: "0", outcome: "0", position_gap_version: "3" }),
        metadataMarketTitle: "Will the canonical market win?",
      },
      date.getTime(),
    );

    expect(order.market_title).toBe("Will the canonical market win?");
    expect(order.outcome).toBe("0");
  });

  it("exposes bounded cancellation codes and keeps venue errors", () => {
    const canceled = toContractRow(
      {
        ...orderRow({
          reason: "position_gap_reconciled",
          error: "must not win",
        }),
        status: "canceled",
      },
      date.getTime(),
    );
    const errored = toContractRow(
      {
        ...orderRow({
          reason: "position_gap_reconciled",
          error: 'clob_error="insufficient balance"',
        }),
        status: "error",
      },
      date.getTime(),
    );
    const unbounded = toContractRow(
      {
        ...orderRow({ reason: "arbitrary user text" }),
        status: "canceled",
      },
      date.getTime(),
    );

    expect(canceled.error).toBe("position_gap_reconciled");
    expect(errored.error).toBe('clob_error="insufficient balance"');
    expect(unbounded.error).toBeNull();
  });

  it("rejects numeric outcome labels as market titles", () => {
    const order = toContractRow(
      orderRow({ title: "0", outcome: "0", position_gap_version: "3" }),
      date.getTime(),
    );

    expect(order.market_title).toBeNull();
    expect(order.outcome).toBe("0");
  });

  it("withholds legacy limit-derived economics while accounting is pending", () => {
    const order = toContractRow(
      orderRow({
        position_gap_version: "3",
        limit_price: 0.386,
        filled_size_usdc: 3.5898,
      }),
      date.getTime(),
    );
    expect(order.filled_size_usdc).toBeNull();
    expect(order.fill_accounting).toEqual({
      status: "pending",
      source: "clob_order_receipt",
    });

    const attempt = toExecuted(attemptRow());
    expect(attempt).toMatchObject({
      availability: "observed",
      price: null,
      shares: null,
      filled_size_usdc: null,
      fees_usdc: null,
      fill_accounting: {
        status: "pending",
        source: "clob_order_receipt",
      },
    });
  });

  it("publishes only complete associated-trade economics", () => {
    const attributes = {
      position_gap_version: "3",
      realized_fill_source: "clob_associated_trades",
      filled_size_usdc: 0.0092,
    };
    const order = toContractRow(orderRow(attributes), date.getTime());
    expect(order.filled_size_usdc).toBe(0.0092);
    expect(order.fill_accounting).toEqual({
      status: "verified",
      source: "clob_associated_trades",
      matched_order_count: 1,
      realized_shares: 9.3,
      realized_entry_notional_usdc: 0.0092,
    });

    const attempt = toExecuted(
      attemptRow({
        exec_price: 0.0092 / 9.3,
        exec_filled_size_usdc: 0.0092,
        exec_realized_fill_source: "clob_associated_trades",
      }),
    );
    expect(attempt).toMatchObject({
      availability: "observed",
      filled_size_usdc: 0.0092,
      fill_accounting: {
        status: "verified",
        source: "clob_associated_trades",
        realized_shares: 9.3,
        realized_entry_notional_usdc: 0.0092,
      },
    });
  });

  it("publishes complete Data-API-corroborated economics with its source", () => {
    const order = toContractRow(
      orderRow({
        position_gap_version: "3",
        realized_fill_source: "data_api_activity_position",
        filled_size_usdc: 0.009295,
      }),
      date.getTime(),
    );
    expect(order).toMatchObject({
      filled_size_usdc: 0.009295,
      fill_accounting: {
        status: "verified",
        source: "data_api_activity_position",
        realized_shares: 9.3,
        realized_entry_notional_usdc: 0.009295,
      },
    });

    const attempt = toExecuted(
      attemptRow({
        exec_price: 0.009295 / 9.3,
        exec_fees_usdc: 0.00046,
        exec_filled_size_usdc: 0.009295,
        exec_realized_fill_source: "data_api_activity_position",
      }),
    );
    expect(attempt).toMatchObject({
      availability: "observed",
      price: 0.009295 / 9.3,
      shares: 9.3,
      fees_usdc: 0.00046,
      filled_size_usdc: 0.009295,
      fill_accounting: {
        status: "verified",
        source: "data_api_activity_position",
      },
    });
  });

  it("preserves legacy and non-PG execution semantics", () => {
    const order = toContractRow(
      orderRow({ filled_size_usdc: 3.5898 }),
      date.getTime(),
    );
    expect(order.filled_size_usdc).toBe(3.5898);
    expect(order.fill_accounting).toBeNull();

    const attempt = toExecuted(
      attemptRow({
        exec_position_gap_version: null,
        exec_filled_size_usdc: null,
      }),
    );
    expect(attempt).toMatchObject({
      availability: "observed",
      price: 0.386,
      shares: 9.3,
      fill_accounting: null,
    });
    expect(
      attempt.availability === "observed" ? attempt.filled_size_usdc : null,
    ).toBeCloseTo(3.5898, 10);
  });
});
