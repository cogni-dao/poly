// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/holdings/view`
 * Purpose: Unified ownership page: wallet tokens, issuance model, then non-token credits.
 * Scope: Composes governance feature panels around the useHoldings read model.
 * Invariants: Token position always precedes issuance explanation and attribution credits.
 * Side-effects: IO via useHoldings; wallet reads/writes inside YourPositionPanel.
 * @public
 */

"use client";

import type { ReactElement } from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  PageContainer,
  Skeleton,
} from "@/components";
import { ContributionCreditsPanel } from "@/features/governance/components/ContributionCreditsPanel";
import { NodeTokenomicsPanel } from "@/features/governance/components/NodeTokenomicsPanel";
import { YourPositionPanel } from "@/features/governance/components/YourPositionPanel";
import { useHoldings } from "@/features/governance/hooks/useHoldings";

interface HoldingsViewProps {
  readonly tokenAddress: string | null;
  readonly chainId: number;
}

export function HoldingsView({
  tokenAddress,
  chainId,
}: HoldingsViewProps): ReactElement {
  const { data, isLoading, error } = useHoldings();

  return (
    <PageContainer maxWidth="2xl">
      <header className="space-y-1">
        <h1 className="font-bold text-3xl tracking-tight">Ownership</h1>
        <p className="max-w-prose text-muted-foreground">
          Your on-chain tokens and the contribution record that earns future
          allocations.
        </p>
      </header>

      <YourPositionPanel tokenAddress={tokenAddress} chainId={chainId} />
      <NodeTokenomicsPanel epochsCompleted={data?.epochsCompleted ?? null} />

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load issuance history</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      ) : isLoading || !data ? (
        <ContributionCreditsSkeleton />
      ) : (
        <ContributionCreditsPanel data={data} />
      )}
    </PageContainer>
  );
}

function ContributionCreditsSkeleton(): ReactElement {
  return (
    <div aria-label="Loading contribution credits">
      <Skeleton className="h-80 w-full rounded-lg" />
    </div>
  );
}
