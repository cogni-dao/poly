// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  PolyWalletDashboardOutputSchema,
  polyWalletDashboardOperation,
  WalletExecutionMarketGroupSchema,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

describe("poly.wallet.dashboard.v1", () => {
  it("pins one snapshot and explicit saved-economic authority for history", () => {
    expect(polyWalletDashboardOperation.id).toBe("poly.wallet.dashboard.v1");
    const shape = PolyWalletDashboardOutputSchema.shape;
    expect(shape.snapshotId).toBeDefined();
    expect(shape.capturedAt).toBeDefined();
    const facts = shape.facts.shape;
    expect(facts.orders.shape.authority.safeParse("provisional_local_ledger").success).toBe(true);
    expect(facts.history.shape.authority.safeParse("saved_wallet_fills_and_outcomes").success).toBe(true);
    expect(facts.positions.shape.previewLimit.safeParse(500).success).toBe(true);
    expect(facts.history.shape.previewLimit.safeParse(30).success).toBe(true);
  });

  it("keeps exact counts nullable so unavailable never parses as false zero", () => {
    const execution = PolyWalletDashboardOutputSchema.shape.execution;
    expect(execution.shape.live_position_count.safeParse(null).success).toBe(true);
    expect(execution.shape.closed_position_count.safeParse(null).success).toBe(true);
    expect(
      execution.shape.originCoverage.safeParse({
        status: "unavailable",
        originPositionCount: null,
        originEventCount: null,
        completeEventCount: null,
        legacyPartialEventCount: null,
        incompleteEventCount: null,
        identityAmbiguousEventCount: null,
        originLayerCount: null,
        comparableLayerCount: null,
        previewLayerCount: null,
        previewTruncated: null,
      }).success
    ).toBe(true);
  });

  it("requires exact origin buckets and honest preview truncation", () => {
    const originCoverage =
      PolyWalletDashboardOutputSchema.shape.execution.shape.originCoverage;
    const available = {
      status: "available",
      originPositionCount: 2,
      originEventCount: 5,
      completeEventCount: 3,
      legacyPartialEventCount: 1,
      incompleteEventCount: 1,
      identityAmbiguousEventCount: 0,
      originLayerCount: 3,
      comparableLayerCount: 1,
      previewLayerCount: 2,
      previewTruncated: true,
    } as const;

    expect(originCoverage.safeParse(available).success).toBe(true);
    expect(
      originCoverage.safeParse({ ...available, previewTruncated: false }).success
    ).toBe(false);
    expect(
      originCoverage.safeParse({ ...available, completeEventCount: 4 }).success
    ).toBe(false);
  });

  it("exposes interval-scoped activity units on the shared snapshot", () => {
    const activity =
      PolyWalletDashboardOutputSchema.shape.execution.shape.tradeActivity;
    expect(
      activity.safeParse({
        bucketUnit: "hour",
        buckets: [{ start: "2026-10-08T11:30:00.000Z", n: 2 }],
      }).success
    ).toBe(true);
    expect(
      activity.safeParse({
        bucketUnit: "week",
        buckets: [],
      }).success
    ).toBe(false);
  });

  it("keeps missing target position economics unavailable instead of zero", () => {
    const shape = WalletExecutionMarketGroupSchema.shape;
    expect(shape.targetEntryValueUsdc.safeParse(null).success).toBe(true);
    expect(shape.targetValueUsdc.safeParse(null).success).toBe(true);
    expect(shape.targetGrossBuyNotionalUsdc.safeParse(null).success).toBe(true);
  });
});
