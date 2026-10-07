// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { positionGapBudgetGroups } from "@/features/copy-trade/target-source";

describe("position-gap runtime budget grouping", () => {
  it("groups automatic targets per account and deduplicates join-expanded rows", () => {
    const groups = positionGapBudgetGroups([
      {
        target_row_id: "target-a1",
        billing_account_id: "account-a",
        sizing_policy_kind: "position_gap",
        mirror_capital_budget_usdc: null,
      },
      {
        target_row_id: "target-a1",
        billing_account_id: "account-a",
        sizing_policy_kind: "position_gap",
        mirror_capital_budget_usdc: null,
      },
      {
        target_row_id: "target-a2",
        billing_account_id: "account-a",
        sizing_policy_kind: "position_gap",
        mirror_capital_budget_usdc: null,
      },
      {
        target_row_id: "target-a3",
        billing_account_id: "account-a",
        sizing_policy_kind: "min_bet",
        mirror_capital_budget_usdc: "50.00",
      },
      {
        target_row_id: "target-b1",
        billing_account_id: "account-b",
        sizing_policy_kind: "position_gap",
        mirror_capital_budget_usdc: "200.00",
      },
      {
        target_row_id: "target-b2",
        billing_account_id: "account-b",
        sizing_policy_kind: "position_gap",
        mirror_capital_budget_usdc: "300.00",
      },
    ]);

    expect(groups.get("account-a")).toEqual({
      explicitBudgetTotalUsdc: 0,
      automaticTargetCount: 2,
      unbudgetedTargetCount: 1,
    });
    expect(groups.get("account-b")).toEqual({
      explicitBudgetTotalUsdc: 500,
      automaticTargetCount: 0,
      unbudgetedTargetCount: 0,
    });
  });
});
