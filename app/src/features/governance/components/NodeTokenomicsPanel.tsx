// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/NodeTokenomicsPanel`
 * Purpose: Explains the node's recurring token issuance model with current scale context.
 * Scope: Presentational only; uses composed finalized-epoch counts.
 * Invariants: Never implies a credit is itself an ERC20 token.
 * Side-effects: none
 * @public
 */

import type { ReactElement } from "react";

import { SectionCard } from "@/components";
import { DistributionModelFlow } from "@/features/governance/components/DistributionModelFlow";

interface NodeTokenomicsPanelProps {
  readonly epochsCompleted: number | null;
}

export function NodeTokenomicsPanel({
  epochsCompleted,
}: NodeTokenomicsPanelProps): ReactElement {
  return (
    <SectionCard title="How issuance works">
      <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
        Token ownership grows through a repeated, cumulative distribution. A
        claim pays only the difference since your last claim.
      </p>
      <DistributionModelFlow />
      <p className="text-muted-foreground text-xs">
        {epochsCompleted === null
          ? "Finalized epoch history is loading or unavailable. The issuance model is unchanged."
          : epochsCompleted === 0
            ? "No epochs have been finalized yet."
            : `${epochsCompleted.toLocaleString()} finalized ${epochsCompleted === 1 ? "epoch is" : "epochs are"} included in the credit history below.`}
      </p>
    </SectionCard>
  );
}
