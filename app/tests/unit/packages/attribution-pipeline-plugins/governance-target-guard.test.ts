// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-pipeline-plugins/governance-target-guard`
 * Purpose: Prove non-production settlement reconciliation cannot target production or unknown governance.
 * Scope: Pure guard tests.
 * Invariants: NONPROD_NEVER_TARGETS_PROD, NULL_BLIND_FAIL_CLOSED.
 * Side-effects: none
 * Links: packages/attribution-pipeline-plugins/src/settlement/governance-target-guard.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { assertSettlementGovernanceTargetSafe } from "../../../../../packages/attribution-pipeline-plugins/src";

const PROD_COGNI_DAO = "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6";
const CANDIDATE_DAO = "0x1111111111111111111111111111111111111111";

describe("assertSettlementGovernanceTargetSafe", () => {
  it("allows candidate-a to build only against a known non-production holder", () => {
    expect(() =>
      assertSettlementGovernanceTargetSafe({
        deploymentEnvironment: "candidate-a",
        emissionsHolderAddress: CANDIDATE_DAO,
        context: "identity binding",
      })
    ).not.toThrow();
  });

  it.each([PROD_COGNI_DAO, null])(
    "rejects candidate-a holder %s",
    (emissionsHolderAddress) => {
      expect(() =>
        assertSettlementGovernanceTargetSafe({
          deploymentEnvironment: "candidate-a",
          emissionsHolderAddress,
          context: "identity binding",
        })
      ).toThrow(/bug\.5020 execute-guard/);
    }
  );

  it("allows production to use its configured holder", () => {
    expect(() =>
      assertSettlementGovernanceTargetSafe({
        deploymentEnvironment: "production",
        emissionsHolderAddress: PROD_COGNI_DAO,
        context: "scheduled retry",
      })
    ).not.toThrow();
  });
});
