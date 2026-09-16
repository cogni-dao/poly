// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/YourPositionPanel`
 * Purpose: Shows one connected wallet's token position and cumulative claim action.
 * Scope: Presentational section around the existing cumulative claim flow.
 * Invariants: Token amounts and contribution credits are never presented as the same asset.
 * Side-effects: Delegates wallet reads and the claim transaction to CumulativeClaimPanel.
 * @public
 */

"use client";

import { WalletCards } from "lucide-react";

import { SectionCard } from "@/components";
import { CumulativeClaimPanel } from "@/features/governance/components/CumulativeClaimPanel";

interface YourPositionPanelProps {
  readonly tokenAddress: string | null;
  readonly chainId: number;
}

export function YourPositionPanel({
  tokenAddress,
  chainId,
}: YourPositionPanelProps) {
  return (
    <SectionCard title="Your tokens">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <WalletCards className="size-5" aria-hidden="true" />
        </div>
        <p className="max-w-prose text-muted-foreground text-sm leading-relaxed">
          See the tokens in your wallet and claim every published allocation in
          one transaction.
        </p>
      </div>
      <CumulativeClaimPanel
        bare
        tokenAddress={tokenAddress}
        chainId={chainId}
      />
    </SectionCard>
  );
}
