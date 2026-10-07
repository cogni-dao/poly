// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  PolyAccountCopySetupResponseSchema,
  polyCopyTradeTargetUpdateOperation,
} from "@cogni/poly-node-contracts";
import { describe, expect, it } from "vitest";

const targetId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const activatedAt = "2026-10-06T12:00:00.000Z";

describe("copy-target assignment contract", () => {
  it("requires a complete algorithm choice and concurrency token", () => {
    const base = {
      id: targetId,
      mirror_filter_percentile: 75,
      mirror_max_usdc_per_trade: 10,
    };

    expect(
      polyCopyTradeTargetUpdateOperation.input.safeParse(base).success,
    ).toBe(false);
    expect(
      polyCopyTradeTargetUpdateOperation.input.safeParse({
        ...base,
        sizing_policy_kind: "min_bet",
        expected_mirror_activated_at: activatedAt,
      }).success,
    ).toBe(true);
  });

	it("accepts position-gap without legacy v1 range controls", () => {
    expect(
      polyCopyTradeTargetUpdateOperation.input.safeParse({
        id: targetId,
        sizing_policy_kind: "position_gap",
        expected_mirror_activated_at: activatedAt,
        mirror_filter_percentile: 75,
        mirror_max_usdc_per_trade: 10,
      }).success,
    ).toBe(true);
  });
});

describe("copy-setup algorithm identity", () => {
  it("makes effective policy and immutable build revision machine-readable", () => {
    const result = PolyAccountCopySetupResponseSchema.safeParse({
      billing_account_id: accountId,
      captured_at: activatedAt,
      targets: [
        {
          target_id: targetId,
          target_wallet: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
          active: true,
          created_at: activatedAt,
          mirror_activated_at: activatedAt,
          disabled_at: null,
          policy: {
            declared_kind: "auto",
            effective_kind: "target_percentile_scaled",
            resolution: "auto_snapshot",
            implementation_revision: {
              status: "available",
              build_sha: "0123456789abcdef0123456789abcdef01234567",
            },
            mirror_filter_percentile: 75,
            mirror_max_usdc_per_trade: 10,
            target_range_max_usdc: null,
            mirror_max_alloc_per_condition_usdc: null,
            range_knobs_incomplete: false,
          },
          activation: { status: "eligible", explanation: "active" },
        },
      ],
      active_target_count: 1,
      targets_truncated: false,
      wallet_safety: {
        status: "absent",
        reason: "no_wallet_grant_on_file",
      },
      sources: {
        targets: "poly_copy_trade_targets",
        caps: "poly_wallet_grants",
        config_table: "dropped_in_migration_0036",
      },
      completeness: {
        complete: false,
        targets_truncated: false,
        caps_available: false,
      },
    });

    expect(result.success).toBe(true);
  });
});
