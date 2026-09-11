// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/settlement/governance-target-guard`
 * Purpose: Prevent a non-production runtime from building settlement revisions against production or unknown governance.
 * Scope: Pure validation shared by finalize, identity-binding, and scheduled reconciliation entrypoints.
 * Invariants: NONPROD_NEVER_TARGETS_PROD, NULL_BLIND_FAIL_CLOSED, DEPLOY_ENVIRONMENT_VALIDATED.
 * Side-effects: none
 * Links: bug.5020, docs/spec/attribution-ledger.md
 * @public
 */

import { parseEIP712DeploymentEnvironment } from "@cogni/attribution-ledger";

const PROD_COGNI_DAO_ADDRESS =
  "0xF61c3fafD4D34b4568e7a500d92b28Ac175e83C6".toLowerCase();

export function assertSettlementGovernanceTargetSafe(params: {
  readonly deploymentEnvironment: string | undefined;
  readonly emissionsHolderAddress: string | null;
  readonly context: string;
}): void {
  const deploymentEnvironment = parseEIP712DeploymentEnvironment(
    params.deploymentEnvironment
  );
  if (deploymentEnvironment === "production") return;

  if (params.emissionsHolderAddress === null) {
    throw new Error(
      `[bug.5020 execute-guard] refusing to build a distribution with an UNKNOWN emissions holder from a non-production runtime (DEPLOY_ENVIRONMENT=${deploymentEnvironment}, ${params.context})`
    );
  }
  if (
    params.emissionsHolderAddress.toLowerCase() === PROD_COGNI_DAO_ADDRESS
  ) {
    throw new Error(
      `[bug.5020 execute-guard] refusing to build a distribution against the PRODUCTION Cogni DAO ${params.emissionsHolderAddress} from a non-production runtime (DEPLOY_ENVIRONMENT=${deploymentEnvironment}, ${params.context})`
    );
  }
}
