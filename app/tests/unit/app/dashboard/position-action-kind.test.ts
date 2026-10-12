// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { positionActionKind } from "@/features/wallet-analysis/position-action-kind";

describe("positionActionKind", () => {
  it("keeps an abandoned but unredeemed winner redeemable from Closed", () => {
    expect(positionActionKind({ status: "redeemable", lifecycleState: "abandoned" }))
      .toBe("redeem");
  });

  it("does not reopen redeemed or losing positions", () => {
    expect(positionActionKind({ status: "closed", lifecycleState: "redeemed" }))
      .toBeNull();
    expect(positionActionKind({ status: "closed", lifecycleState: "loser" }))
      .toBeNull();
  });
});
