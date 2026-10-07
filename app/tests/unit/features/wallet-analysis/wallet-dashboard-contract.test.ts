// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  PolyWalletDashboardOutputSchema,
  polyWalletDashboardOperation,
  WalletExecutionMarketGroupSchema,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

describe("poly.wallet.dashboard.v1", () => {
  it("pins one snapshot and explicit local-ledger authority for orders and history", () => {
    expect(polyWalletDashboardOperation.id).toBe("poly.wallet.dashboard.v1");
    const shape = PolyWalletDashboardOutputSchema.shape;
    expect(shape.snapshotId).toBeDefined();
    expect(shape.capturedAt).toBeDefined();
    const facts = shape.facts.shape;
    expect(facts.orders.shape.authority.safeParse("provisional_local_ledger").success).toBe(true);
    expect(facts.history.shape.authority.safeParse("provisional_local_ledger").success).toBe(true);
    expect(facts.positions.shape.previewLimit.safeParse(500).success).toBe(true);
    expect(facts.history.shape.previewLimit.safeParse(30).success).toBe(true);
  });

  it("keeps exact counts nullable so unavailable never parses as false zero", () => {
    const execution = PolyWalletDashboardOutputSchema.shape.execution;
    expect(execution.shape.live_position_count.safeParse(null).success).toBe(true);
    expect(execution.shape.closed_position_count.safeParse(null).success).toBe(true);
  });

  it("keeps missing target position economics unavailable instead of zero", () => {
    const shape = WalletExecutionMarketGroupSchema.shape;
    expect(shape.targetEntryValueUsdc.safeParse(null).success).toBe(true);
    expect(shape.targetValueUsdc.safeParse(null).success).toBe(true);
    expect(shape.targetGrossBuyNotionalUsdc.safeParse(null).success).toBe(true);
  });
});
